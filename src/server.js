const fs = require('fs')
const net = require('net')
const path = require('path')
const parse = require('url').parse

const sni = require('./sni')
const hook = require('./hook')
const request = require('./request')
const manage = require('./manage')

const shouldLogHost = host => host && (
	host.endsWith('music.163.com') ||
	host.endsWith('music.126.net') ||
	host.endsWith('netease.com') ||
	host.endsWith('163.com')
)

const proxy = {
	core: {
		mitm: (req, res) => {
			if (req.url.startsWith('/__unm/')) {
				return Promise.resolve(manage.handle(req, res)).catch(() => {})
			}
			if (req.url == '/proxy.pac') {
				const url = parse('http://' + req.headers.host)
				const hosts = Array.from(hook.target.host).filter(host => net.isIP(host) === 0 && host !== 'localhost')
				res.writeHead(200, {'Content-Type': 'application/x-ns-proxy-autoconfig'})
				res.end(`
					function FindProxyForURL(url, host) {
						if (${hosts.map(host => (`host == '${host}'`)).join(' || ') || 'false'} || dnsDomainIs(host, '.music.163.com')) {
							return 'PROXY ${url.hostname}:${url.port || 80}'
						}
						return 'DIRECT'
					}
				`)
			}
			else {
				const ctx = {res, req}
				Promise.resolve()
				.then(() => proxy.protect(ctx))
				.then(() => proxy.authenticate(ctx))
				.then(() => hook.request.before(ctx))
				.then(() => proxy.filter(ctx))
				.then(() => proxy.log(ctx))
				.then(() => proxy.mitm.request(ctx))
				.then(() => hook.request.after(ctx))
				.then(() => proxy.mitm.response(ctx))
				.catch(() => proxy.mitm.close(ctx))
			}
		},
		tunnel: (req, socket, head) => {
			req.originalUrl = req.url
			const ctx = {req, socket, head}
			Promise.resolve()
			.then(() => proxy.protect(ctx))
			.then(() => proxy.authenticate(ctx))
			.then(() => hook.connect.before(ctx))
			.then(() => proxy.filter(ctx))
			.then(() => proxy.log(ctx))
			.then(() => proxy.tunnel.connect(ctx))
			.then(() => proxy.tunnel.dock(ctx))
			.then(() => hook.negotiate.before(ctx))
			.then(() => proxy.tunnel.pipe(ctx))
			.catch(() => proxy.tunnel.close(ctx))
		}
	},
	abort: (socket, from) => {
		// console.log('call abort', from)
		if (socket) socket.end()
		if (socket && !socket.destroyed) socket.destroy()
	},
	protect: ctx => {
		const {req, res, socket} = ctx
		if (req) req.on('error', () => proxy.abort(req.socket, 'req'))
		if (res) res.on('error', () => proxy.abort(res.socket, 'res'))
		if (socket) socket.on('error', () => proxy.abort(socket, 'socket'))
	},
	log: ctx => {
		const {req, socket, decision} = ctx
		const mark = {close: '|', blank: '-', proxy: '>'}[decision] || '>'
		if (socket) {
			const host = parse('https://' + (req.originalUrl || req.url)).hostname
			if (!shouldLogHost(host)) return
			console.log('TUNNEL', mark, req.url, req.originalUrl ? `(from ${req.originalUrl})` : '')
		}
		else {
			if (!shouldLogHost(parse(req.url).hostname)) return
			console.log('MITM', mark, parse(req.url).host, req.socket.encrypted ? '(ssl)' : '')
		}
	},
	authenticate: ctx => {
		const {req, res, socket} = ctx
		const credential = Buffer.from((req.headers['proxy-authorization'] || '').split(/\s+/).pop() || '', 'base64').toString()
		if ('proxy-authorization' in req.headers) delete req.headers['proxy-authorization']
		if (server.authentication && credential != server.authentication && (socket || req.url.startsWith('http://'))) {
			if (socket)
				socket.write('HTTP/1.1 407 Proxy Auth Required\r\nProxy-Authenticate: Basic realm="realm"\r\n\r\n')
			else
				res.writeHead(407, {'proxy-authenticate': 'Basic realm="realm"'})
			return Promise.reject(ctx.error = 'authenticate')
		}
	},
	filter: ctx => {
		if (ctx.decision || ctx.req.local) return
		const url = parse((ctx.socket ? 'https://' : '') + ctx.req.url)
		const match = pattern => url.href.search(new RegExp(pattern, 'g')) != -1
		try {
			const allow = server.whitelist.some(match)
			const deny = server.blacklist.some(match)
			// console.log('allow', allow, 'deny', deny)
			if (!allow && deny) {
				return Promise.reject(ctx.error = 'filter')
			}
		}
		catch(error) {
			ctx.error = error
		}
	},
	mitm: {
		request: ctx => new Promise((resolve, reject) => {
			if (ctx.decision === 'close') return reject(ctx.error = ctx.decision)
			const {req} = ctx
			const url = parse(req.url)
				if (url.hostname && url.hostname.includes('music.163.com')) {
					console.log('REQ', '>', req.method, url.hostname, url.path)
				}
			const options = request.configure(req.method, url, req.headers)
			ctx.proxyReq = request.create(url)(options)
			.on('response', proxyRes => resolve(ctx.proxyRes = proxyRes))
			.on('error', error => reject(ctx.error = error))
			req.readable ? req.pipe(ctx.proxyReq) : ctx.proxyReq.end(req.body)
		}),
		response: ctx => {
			const {req, res, proxyRes} = ctx
			const url = req && parse(req.url)
			if (url && url.path && url.path.startsWith('/api/pccache/patch/get')) {
				return request.read(proxyRes, true)
				.then(buffer => {
					console.log('PCCACHE', '>', proxyRes.statusCode, buffer.toString().slice(0, 500))
					proxyRes.body = buffer
				})
				.then(() => {
					res.writeHead(proxyRes.statusCode, proxyRes.headers)
					res.end(proxyRes.body)
				})
			}
			proxyRes.on('error', () => proxy.abort(proxyRes.socket, 'proxyRes'))
			res.writeHead(proxyRes.statusCode, proxyRes.headers)
			proxyRes.readable ? proxyRes.pipe(res) : res.end(proxyRes.body)
		},
		close: ctx => {
			proxy.abort(ctx.res.socket, 'mitm')
		}
	},
	tunnel: {
		connect: ctx => new Promise((resolve, reject) => {
			if (ctx.decision === 'close') return reject(ctx.error = ctx.decision)
			const {req} = ctx
			const url = parse('https://' + req.url)
			if (global.proxy && !req.local) {
				const options = request.configure(req.method, url, req.headers)
				request.create(proxy)(options)
				.on('connect', (_, proxySocket) => resolve(ctx.proxySocket = proxySocket))
				.on('error', error => reject(ctx.error = error))
				.end()
			}
			else {
				const proxySocket = net.connect(url.port || 443, request.translate(url.hostname))
				.on('connect', () => resolve(ctx.proxySocket = proxySocket))
				.on('error', error => reject(ctx.error = error))
			}
		}),
		dock: ctx => new Promise(resolve => {
			const {req, head, socket} = ctx
			socket
			.once('data', data => {
				resolve(ctx.head = Buffer.concat([head, data]))
			})
			.write(`HTTP/${req.httpVersion} 200 Connection established\r\n\r\n`)
		}).then(data => {
			ctx.socket.sni = sni(data)
			if (shouldLogHost(ctx.socket.sni)) {
				console.log('SNI', '>', ctx.socket.sni || '(none)', ctx.req.originalUrl ? `(from ${ctx.req.originalUrl})` : '')
			}
		}).catch(() => {}),
		pipe: ctx => {
			if (ctx.decision === 'blank') return Promise.reject(ctx.error = ctx.decision)
			const {head, socket, proxySocket} = ctx
			proxySocket.on('error', () => proxy.abort(ctx.proxySocket, 'proxySocket'))
			proxySocket.write(head)
			socket.pipe(proxySocket)
			proxySocket.pipe(socket)
		},
		close: ctx => {
			if (ctx.error) {
				const error = ctx.error && (ctx.error.code || ctx.error.message || ctx.error)
				const host = ctx.req && parse('https://' + (ctx.req.originalUrl || ctx.req.url)).hostname
				if (shouldLogHost(host)) {
					console.log('TUNNEL', '!', error, ctx.req && ctx.req.originalUrl ? `(from ${ctx.req.originalUrl})` : '')
				}
			}
			proxy.abort(ctx.socket, 'tunnel')
		}
	}
}

const options = {
	key: fs.readFileSync(path.join(__dirname, '..', 'server.key')),
	cert: fs.readFileSync(path.join(__dirname, '..', 'server.crt'))
}

const server = {
	http: require('http').createServer().on('request', proxy.core.mitm).on('connect', proxy.core.tunnel),
	https: require('https').createServer(options).on('request', proxy.core.mitm).on('connect', proxy.core.tunnel)
}

server.whitelist = []
server.blacklist = ['://127\\.\\d+\\.\\d+\\.\\d+', '://localhost']
server.authentication = null

module.exports = server