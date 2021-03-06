import crypto from 'crypto'
import moment from 'moment'
import axios from 'axios'
import OauthError from './errors/OauthError'

/**
 * @class
 * @alias Easy
 */
export default class {
	constructor(app) {
		this.app = app

		app.post('/authorize', this.authorization.bind(this))
		app.post('/token', this.tokenWrapper.bind(this))
	}

	async authorization(req, res, next) {
		let { client_id, scope, state, response_type, redirect_uri } = req.body
		let userId = req.userId

		if (!req.userId) {
			res.redirect('http://localhost:3000/login')
		}

		let application = await this.getApplication(client_id)
		if (!application) {
			return res.status(400).send('Client not found')
		}
		this.verifyIfRedirectUriIsValid(application.redirectURI)
		this.verifyClientType(application.clientType)

		let user = await this.getUser(userId)
		if (!user) {
			return res.status(400).send('User not found')
		}

		if (application.redirectURI !== redirect_uri) {
			return res.status(400).send('Redirect URI mismatch!')
		}
		if (response_type === 'code') {
			let code = await this.generateAuthorizationCode({ userId, clientId: application.clientId, scope })

			return res.redirect(application.redirectURI + '?' + serialize({ code, state }))
		} else {
			return res.status(400).redirect(application.redirectURI + '?error=unsuported_response_type')
		}
	}

	async generateAuthorizationCode({ clientId, userId, scope }) {
		let code = 'smash_authorization_code_' + 'fixo' //crypto.randomBytes(32).toString('hex')

		this.saveAuthorizationCode({ code, clientId, userId, scope })
		return code
	}

	async tokenWrapper(req, res, next) {
		try {
			await this.token(req, res, next)
		} catch (error) {
			if (error instanceof OauthError) {
				if (error.redirectUri) {
					res.status(400).redirect(error.redirectUri + '?error=' + error.error)
				} else {
					res.status(400).send({
						error: error.error,
						error_description: error.errorDescription
					})
				}
			} else {
				res.status(400).send({ error: 'unexpected' })
			}
		}
	}

	async token(req, res, next) {
		let { grant_type, client_id, client_secret } = req.body

		let application = await this.getApplication(client_id)
		if (!application) {
			throw new OauthError({ error: 'invalid_client', errorDescription: 'Client not found' })
		}
		this.verifyIfRedirectUriIsValid(application.redirectURI)
		this.verifyClientType(application.clientType)

		if (application.clientType === 'confidential' && application.clientSecret !== client_secret) {
			throw new OauthError({ error: 'unauthorized_client', errorDescription: 'Invalid secret mismatch' })
		}

		if (grant_type === 'authorization_code') {
			let { code } = req.body

			let authorizationCode = await this.getAuthorizationCode(client_id, code)
			if (!authorizationCode) {
				throw new OauthError({ error: 'invalid_grant', errorDescription: 'Authorization code not found' })
			}

			let { userId, scope } = authorizationCode

			let accessToken = await this.generateAccessToken({ ...application, grantType: grant_type, scope, userId })
			res.send(this.getTokenResponse(accessToken))
			return this.revokeAuthorizationCode(code)
		}
		if (grant_type === 'password') {
			let { username, password, scope } = req.body
			let userId = await this.verifyUsernameAndPassword(username, password)
			if (!userId) {
				throw new OauthError({ error: 'invalid_grant', errorDescription: 'User not found or password invalid' })
			}

			let accessToken = await this.generateAccessToken({ ...application, grantType: grant_type, scope, userId })
			return res.send(this.getTokenResponse(accessToken))
		}
		if (grant_type === 'client_credentials') {
			let { scope } = req.body
			if (application.clientType === 'public') {
				throw new OauthError({
					error: 'unsupported_grant_type',
					errorDescription: 'Only enabled to confidential clients'
				})
			}

			let accessToken = await this.generateAccessToken({ ...application, grantType: grant_type, scope })
			return res.send(this.getTokenResponse(accessToken))
		}
		if (grant_type === 'refresh_token') {
			let { refresh_token } = req.body
			let oldAccessToken = await this.getAccessTokenByRefreshToken(client_id, refresh_token)
			if (!oldAccessToken) {
				throw new OauthError({ error: 'invalid_grant', errorDescription: 'Refresh token not found' })
			}
			let { scope } = oldAccessToken

			let accessToken = await this.generateAccessToken({ ...application, grantType: grant_type, scope })
			res.send(this.getTokenResponse(accessToken))
			return this.revokeRefreshToken(client_id, refresh_token)
		}
	}

	/** @returns { Promise<AccessToken> } */
	async generateAccessToken({ clientId, scope, grantType, userId }) {
		let accessToken = 'smash_access_token_' + crypto.randomBytes(32).toString('hex')
		let accessTokenExpiresOn = moment().add(1, 'hour')
		let refreshToken
		let refreshTokenExpiresOn
		if (grantType !== 'client_credentials') {
			refreshToken = 'smash_refresh_token_' + crypto.randomBytes(32).toString('hex')
			refreshTokenExpiresOn = moment().add(30, 'days')
		}

		let obj = { accessToken, accessTokenExpiresOn, refreshToken, refreshTokenExpiresOn, clientId, userId, scope }
		return this.saveAccessToken(obj)
	}

	getTokenResponse(accessToken) {
		return {
			access_token: accessToken.accessToken,
			token_type: 'bearer',
			expires_in: 3600,
			refresh_token: accessToken.refreshToken
		}
	}

	static get REVOKED_TOKEN() {
		return 'REVOKED'
	}

	verifyIfRedirectUriIsValid(redirectURI) {
		let reg = /.+:\/\/.+/
		if (!reg.test(redirectURI)) {
			throw new Error('Invalid uri') //TODO implementar maybe not 404 on get
		}
	}

	verifyClientType(clientType) {
		if (!['confidential', 'public'].includes(clientType)) {
			throw new Error('Invalid client type')
		}
	}

	// Must implement

	/** @param { App } */
	async saveApplication({ name, website, logo, redirectURI, devUserId, clientId, clientSecret, clientType }) {
		throw new Error('Must implement')
	}

	/** @returns { Promise<App> } */
	async getApplication(clientId) {
		throw new Error('Must implement')
	}

	/** @param { AccessToken } */
	async saveAccessToken({
		accessToken,
		accessTokenExpiresOn,
		refreshToken,
		refreshTokenExpiresOn,
		clientId,
		userId,
		scope
	}) {
		throw new Error('Must implement')
	}

	/** @returns { Promise<AuthorizationCode> } */
	async saveAuthorizationCode({ code, clientId, userId, scope }) {
		throw new Error('Must implement')
	}

	/** @returns { Promise<AuthorizationCode> } */
	async getAuthorizationCode(clientId, code) {
		throw new Error('Must implement')
	}

	async renderAuthorizationView() {
		throw new Error('Must implement')
	}

	/** @returns { Promise<String> } Returns user id */
	async verifyUsernameAndPassword(username, password) {
		throw new Error('Must implement')
	}

	async getDevUser(devUserId) {
		throw new Error('Must implement')
	}

	async getUser(userId) {
		throw new Error('Must implement')
	}

	/** @returns { Promise<AccessToken> } */
	async getAccessTokenByRefreshToken(clientId, refreshToken) {
		throw new Error('Must implement')
	}

	async revokeRefreshToken(clientId, refreshToken) {
		throw new Error('Must implement')
	}

	async revokeAuthorizationCode(clientId, code) {
		throw new Error('Must implement')
	}
}

function serialize(obj) {
	var str = []
	for (var p in obj) {
		if (obj.hasOwnProperty(p)) {
			str.push(encodeURIComponent(p) + '=' + encodeURIComponent(obj[p]))
		}
	}
	return str.join('&')
}

/**
 * @typedef App
 * @property {string} name
 * @property {string} website
 * @property {string} logo
 * @property {string} redirectURI
 * @property {string} devUserId
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string} clientType
 */

/**
 * @typedef AuthorizationCode
 * @property {string} code
 * @property {string} clientId
 * @property {string} userId
 * @property {string} scope
 */

/**
 * @typedef AccessToken
 * @property {string} accessToken
 * @property {string} accessTokenExpiresOn
 * @property {string} refreshToken
 * @property {string} refreshTokenExpiresOn
 * @property {string} clientId
 * @property {string} userId
 * @property {string} scope
 */
