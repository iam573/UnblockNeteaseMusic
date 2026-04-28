const fs = require('fs')
const path = require('path')
const parse = require('url').parse
const match = require('./provider/match')

const readBody = req =>
	new Promise((resolve, reject) => {
		const chunks = []
		req.on('data', chunk => chunks.push(chunk))
		req.on('end', () => resolve(Buffer.concat(chunks).toString()))
		req.on('error', reject)
	})

const send = (res, statusCode, body, headers = {}) => {
	res.writeHead(statusCode, Object.assign({
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store'
	}, headers))
	res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const sendFile = (res, file) => {
	const content = fs.readFileSync(file)
	res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'})
	res.end(content)
}

const handle = async (req, res) => {
	const url = parse(req.url, true)
	const p = url.pathname
	const isConsole = p === '/console' || p.startsWith('/__unm/')
	if (!isConsole) return false
	if (req.method === 'GET' && (p === '/console' || p === '/__unm/sources')) {
		return sendFile(res, path.join(__dirname, '..', 'public', 'sources.html')), true
	}
	if (req.method === 'GET' && p === '/__unm/api/sources') {
		return send(res, 200, match.sourceManager.getState()), true
	}
	if (req.method === 'POST' && p === '/__unm/api/sources/save') {
		const payload = JSON.parse(await readBody(req) || '{}')
		return send(res, 200, match.sourceManager.save(payload)), true
	}
	if (req.method === 'GET' && p === '/__unm/api/sources/health') {
		const keyword = (url.query || {}).keyword || '周杰伦'
		const result = await match.sourceManager.checkSources(match.provider, keyword)
		return send(res, 200, {keyword, result}), true
	}
	return send(res, 404, {error: 'Not Found'}), true
}

module.exports = {handle}
