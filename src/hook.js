const cache = require('./cache')
const parse = require('url').parse
const crypto = require('./crypto')
const request = require('./request')
const match = require('./provider/match')
const querystring = require('querystring')
const zlib = require('zlib')

const hook = {
	request: {
		before: () => {},
		after: () => {},
	},
	connect: {
		before: () => {}
	},
	negotiate: {
		before: () => {}
	},
	target: {
		host: new Set(),
		path: new Set()
	}
}

const isMusicHost = host => host && (hook.target.host.has(host) || host.endsWith('.music.163.com'))

hook.target.host = new Set([
	'music.163.com',
	'interface.music.163.com',
	'interface3.music.163.com',
	'apm.music.163.com',
	'apm3.music.163.com',
	// 'mam.netease.com',
	// 'api.iplay.163.com', // look living
	// 'ac.dun.163yun.com',
	// 'crash.163.com',
	// 'clientlog.music.163.com',
	// 'clientlog3.music.163.com'
])

hook.target.path = new Set([
	'/api/v3/playlist/detail',
	'/api/v3/song/detail',
	'/api/v6/playlist/detail',
	'/api/album/play',
	'/api/artist/privilege',
	'/api/album/privilege',
	'/api/v1/artist',
	'/api/v1/artist/songs',
	'/api/artist/top/song',
	'/api/v1/album',
	'/api/album/v3/detail',
	'/api/playlist/privilege',
	'/api/song/enhance/player/url',
	'/api/song/enhance/player/url/v1',
	'/api/song/enhance/download/url',
	'/api/song/enhance/download/url/v1',
	'/api/song/enhance/privilege',
	'/batch',
	'/api/batch',
	'/api/v1/search/get',
	'/api/v1/search/song/get',
	'/api/search/complex/get',
	'/api/cloudsearch/pc',
	'/api/v1/playlist/manipulate/tracks',
	'/api/song/like',
	'/api/v1/play/record',
	'/api/playlist/v4/detail',
	'/api/v1/radio/get',
	'/api/v1/discovery/recommend/songs',
	'/api/mac/upgrade/get',
	'/api/osx/version'
])

const domainList = [
	'music.163.com', 
	'music.126.net',
	'iplay.163.com',
	'look.163.com',
	'y.163.com',
]

hook.request.before = ctx => {
	const {req} = ctx
	req.url = (req.url.startsWith('http://') ? '' : (req.socket.encrypted ? 'https:' : 'http:') + '//' + (domainList.some(domain => (req.headers.host || '').endsWith(domain)) ? req.headers.host : null)) + req.url
	const url = parse(req.url)
	if ([url.hostname, req.headers.host].some(host => host.includes('music.163.com'))) ctx.decision = 'proxy'
	if ([url.hostname, req.headers.host].some(host => hook.target.host.has(host)) && req.method == 'POST' && (url.path == '/api/linux/forward' || url.path.startsWith('/eapi/'))) {
		return request.read(req)
		.then(body => req.body = body)
		.then(body => {
			if ('x-napm-retry' in req.headers) delete req.headers['x-napm-retry']
			req.headers['X-Real-IP'] = '118.88.88.88'
			if (req.url.includes('stream')) return // look living eapi can not be decrypted
			if (body) {
				let data = null
				const netease = {}
				netease.pad = (body.match(/%0+$/) || [''])[0]
				netease.forward = (url.path == '/api/linux/forward')
				if (netease.forward) {
					data = JSON.parse(crypto.linuxapi.decrypt(Buffer.from(body.slice(8, body.length - netease.pad.length), 'hex')).toString())
					netease.path = parse(data.url).path
					netease.param = data.params
				}
				else {
					data = crypto.eapi.decrypt(Buffer.from(body.slice(7, body.length - netease.pad.length), 'hex')).toString().split('-36cd479b6b5-')
					netease.path = data[0]
					netease.param = JSON.parse(data[1])
				}
					netease.e_r = ['true', '1', true, 1].includes(netease.param && netease.param.e_r)
					netease.path = netease.path.replace(/\/\d*$/, '')
				ctx.netease = netease
				console.log('[UNM] request:', netease.path, 'param:', JSON.stringify(netease.param).slice(0, 160))
				// console.log(netease.path, netease.param)

				if (netease.path.startsWith('/api/song/enhance/download/url'))
					return pretendPlay(ctx)
			}
		})
		.catch(error => console.log(error, req.url))
	}
	else if ((hook.target.host.has(url.hostname)) && (url.path.startsWith('/weapi/') || url.path.startsWith('/api/'))) {
		req.headers['X-Real-IP'] = '118.88.88.88'
		ctx.netease = {web: true, path: url.path.replace(/^\/weapi\//, '/api/').replace(/\?.+$/, '').replace(/\/\d*$/, '')}
	}
	else if (req.url.includes('package')) {
		try {
			const data = req.url.split('package/').pop().split('/')
			const url = parse(crypto.base64.decode(data[0]))
			const id = data[1].replace(/\.\w+/, '')
			req.url = url.href
			req.headers['host'] = url.hostname
			req.headers['cookie'] = null
			ctx.package = {id}
			ctx.decision = 'proxy'
			// if (url.href.includes('google'))
			// 	return request('GET', req.url, req.headers, null, parse('http://127.0.0.1:1080'))
			// 	.then(response => (ctx.res.writeHead(response.statusCode, response.headers), response.pipe(ctx.res)))
		}
		catch(error) {
			ctx.error = error
			ctx.decision = 'close'
		}
	}
}

hook.request.after = ctx => {
	const {req, proxyRes, netease, package} = ctx
	if (req.headers.host === 'tyst.migu.cn' && proxyRes.headers['content-range'] && proxyRes.statusCode === 200) proxyRes.statusCode = 206
	if (netease && hook.target.path.has(netease.path) && proxyRes.statusCode == 200) {
		return request.read(proxyRes, true)
		.then(buffer => buffer.length ? proxyRes.body = buffer : Promise.reject())
		.then(buffer => {
			const patch = string => string.replace(/([^\\]"\s*:\s*)(\d{16,})(\s*[}|,])/g, '$1"$2L"$3') // for js precision
			const normalizeJsonText = text => {
				text = String(text || '').replace(/^\uFEFF/, '').replace(/\0+$/g, '').trim()
				const starts = [text.indexOf('{'), text.indexOf('[')].filter(index => index >= 0)
				const start = starts.length ? Math.min.apply(null, starts) : -1
				const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
				if (start >= 0 && end > start) text = text.slice(start, end + 1)
				return text
			}
			const parseJson = buffer => JSON.parse(patch(normalizeJsonText(buffer.toString())))
			const parseEncrypted = (payload, label) => {
				const maxSkip = Math.min(8, Math.max(0, payload.length - 16))
				for (let skip = 0; skip <= maxSkip; skip += 1) {
					try {
						const sliced = payload.slice(skip)
						const rem = sliced.length % 16
						const aligned = rem ? sliced.slice(0, sliced.length - rem) : sliced
						if (aligned.length < 16) continue
						return [parseJson(crypto.eapi.decrypt(aligned)), true, `${label}@${skip}`]
					}
					catch (e) {}
				}
				throw new Error(`unable to parse encrypted payload: ${label}`)
			}
			const parseBody = () => {
				const candidates = [
					['plain', () => [parseJson(buffer), false, 'plain']],
					['br', () => [parseJson(zlib.brotliDecompressSync(buffer)), false, 'br']],
					['br-eapi', () => parseEncrypted(zlib.brotliDecompressSync(buffer), 'br-eapi')],
					['br-eapi-response', () => [parseJson(crypto.eapi.decryptResponse(zlib.brotliDecompressSync(buffer))), true, 'br-eapi-response']],
					['eapi-response', () => [parseJson(crypto.eapi.decryptResponse(buffer)), true, 'eapi-response']],
					['eapi', () => parseEncrypted(buffer, 'eapi')],
				]
				for (const [mode, parser] of candidates) {
					try {
						const [jsonBody, encrypted, detail] = parser()
						netease.jsonBody = jsonBody
						netease.encrypted = encrypted
						netease.parseMode = detail || mode
						return true
					}
					catch(e) {}
				}
				return false
			}
			if (!parseBody()) {
				let brInfo = 'n/a'
				try {
					const br = zlib.brotliDecompressSync(buffer)
					brInfo = `len=${br.length} head=${br.slice(0, 16).toString('hex')} text=${JSON.stringify(br.toString().slice(0, 80))}`
				}
				catch (e) {}
				console.log('[UNM] parse failed:', netease.path, 'len:', buffer.length, 'enc:', proxyRes.headers && proxyRes.headers['content-encoding'], 'head:', buffer.slice(0, 16).toString('hex'), 'br:', brInfo)
				return
			}
			console.log('[UNM] parsed:', netease.path, 'mode:', netease.parseMode, 'code:', netease.jsonBody.code, 'data:', Array.isArray(netease.jsonBody.data) ? netease.jsonBody.data.length : typeof(netease.jsonBody.data))

			if (netease.path == '/api/mac/upgrade/get' || netease.path == '/api/osx/version') {
				netease.jsonBody = Object.assign({}, netease.jsonBody, {
					code: 200,
					data: null,
					update: false,
					upgrade: false,
					hasUpdate: false,
					needUpdate: false,
					forceUpdate: false,
					version: null,
					url: null
				})
				console.log('[UNM] blocked update:', netease.path)
			}
			else if (new Set([401, 512]).has(netease.jsonBody.code) && !netease.web) {
				if (netease.path.includes('manipulate')) return tryCollect(ctx)
				else if (netease.path == '/api/song/like') return tryLike(ctx)
			}
			else if (netease.path.includes('url')) return tryMatch(ctx)
		})
		.then(() => {
			if (!netease.jsonBody) return
			if (!proxyRes.headers) return
			['transfer-encoding', 'content-encoding', 'content-length'].filter(key => key in proxyRes.headers).forEach(key => delete proxyRes.headers[key])

			const inject = (key, value) => {
				if (typeof(value) === 'object' && value != null) {
					if ('fee' in value) value['fee'] = 0
					if ('payed' in value) value['payed'] = 0
					if ('status' in value) value['status'] = 0
					if ('noCopyrightRcmd' in value) value['noCopyrightRcmd'] = null
					if ('freeTrialInfo' in value) value['freeTrialInfo'] = null
					if ('preSell' in value) value['preSell'] = false
					if ('playable' in value) value['playable'] = true
					if ('toast' in value) value['toast'] = false
					if ('cs' in value) value['cs'] = false
					if ('flag' in value) value['flag'] = 4
					if ('copyright' in value) value['copyright'] = 1
					if ('resCopyright' in value) value['resCopyright'] = 1
					if ('copyrightId' in value) value['copyrightId'] = 0
					if ('rightSource' in value) value['rightSource'] = 0
					if ('rscl' in value) value['rscl'] = null
					if ('freeTrialPrivilege' in value) {
						value['freeTrialPrivilege'] = Object.assign({}, value['freeTrialPrivilege'], {
							resConsumable: false,
							userConsumable: false,
							listenType: null,
							cannotListenReason: null,
							playReason: null,
							freeLimitTagType: null
						})
					}
					if ('chargeInfoList' in value && Array.isArray(value['chargeInfoList'])) {
						value['chargeInfoList'] = value['chargeInfoList'].map(info => Object.assign({}, info, {chargeType: 0, chargeUrl: null, chargeMessage: null}))
					}
					if ('st' in value && 'pl' in value && 'dl' in value && 'subp' in value) { // batch modify
						value['st'] = 0
						value['subp'] = 1
						value['pl'] = (value['pl'] == 0) ? 320000 : value['pl']
						value['dl'] = (value['dl'] == 0) ? 320000 : value['dl']
						if ('sp' in value) value['sp'] = 7
						if ('cp' in value) value['cp'] = 1
						if ('fl' in value) value['fl'] = (value['fl'] == 0) ? 320000 : value['fl']
						if ('maxbr' in value) value['maxbr'] = (value['maxbr'] == 0) ? 320000 : value['maxbr']
						if ('playMaxbr' in value) value['playMaxbr'] = (value['playMaxbr'] == 0) ? 320000 : value['playMaxbr']
						if ('downloadMaxbr' in value) value['downloadMaxbr'] = (value['downloadMaxbr'] == 0) ? 320000 : value['downloadMaxbr']
						if ('plLevel' in value) value['plLevel'] = 'exhigh'
						if ('dlLevel' in value) value['dlLevel'] = 'exhigh'
						if ('flLevel' in value) value['flLevel'] = 'exhigh'
						if ('maxBrLevel' in value) value['maxBrLevel'] = 'exhigh'
						if ('playMaxBrLevel' in value) value['playMaxBrLevel'] = 'exhigh'
						if ('downloadMaxBrLevel' in value) value['downloadMaxBrLevel'] = 'exhigh'
					}
				}
				return value
			}

			let body = JSON.stringify(netease.jsonBody, inject)
			body = body.replace(/([^\\]"\s*:\s*)"(\d{16,})L"(\s*[}|,])/g, '$1$2$3') // for js precision
			proxyRes.body = ((netease.encrypted || netease.e_r) ? crypto.eapi.encrypt(Buffer.from(body)) : body)
		})
		.catch(error => error ? console.log(error, req.url) : null)
	}
	else if (package) {
		if (new Set([201, 301, 302, 303, 307, 308]).has(proxyRes.statusCode)) {
			return request(req.method, parse(req.url).resolve(proxyRes.headers.location), req.headers)
			.then(response => ctx.proxyRes = response)
		}
		else if (/p\d+c*.music.126.net/.test(req.url)) {
			proxyRes.headers['content-type'] = 'audio/*'
		}
	}
}

hook.connect.before = ctx => {
	const {req} = ctx
	const url = parse('https://' + req.url)
	if ([url.hostname, req.headers.host].some(isMusicHost)) {
		if (url.port == 80) {
			req.url = `${global.address || 'localhost'}:${global.port[0]}`
			req.local = true
		}
		else if (global.port[1]) {
			req.url = `${global.address || 'localhost'}:${global.port[1]}`
			req.local = true
		}
		else {
			ctx.decision = 'blank'
		}
	}
	else if (url.href.includes(global.endpoint)) ctx.decision = 'proxy'
}

hook.negotiate.before = ctx => {
	const {req, socket, decision} = ctx
	const url = parse('https://' + req.url)
	const target = hook.target.host
	if (req.local || decision) return
	if (isMusicHost(socket.sni) && !isMusicHost(url.hostname)) {
		target.add(url.hostname)
		ctx.decision = 'blank'
	}
}

const pretendPlay = ctx => {
	const {req, netease} = ctx
	const v1 = netease.path === '/api/song/enhance/download/url/v1'
	const turn = `http://music.163.com/api/song/enhance/player/url${v1 ? '/v1' : ''}`
	const normalizeIds = value => {
		if (typeof(value) === 'string' && value.trim()) {
			const text = value.trim()
			if (/^\[.*\]$/.test(text)) return text
			if (/^\d+$/.test(text)) return `[${text}]`
			return JSON.stringify([text])
		}
		if (Array.isArray(value)) return JSON.stringify(value.map(item => {
			const text = item != null ? item.toString() : ''
			return /^\d+$/.test(text) ? Number(text) : text
		}))
		if (value != null) {
			const text = value.toString()
			return /^\d+$/.test(text) ? `[${text}]` : JSON.stringify([text])
		}
		return '[]'
	}
	let query = null
	if (netease.forward) {
		if (v1) {
			const {id, ids, level, immerseType, encodeType, trialMode} = netease.param
			netease.param = {
				ids: normalizeIds(ids || id),
				level: level || 'exhigh',
				encodeType: encodeType || 'mp3',
				immerseType,
				trialMode,
				e_r: false
			}
		}
		else {
			const {id, br} = netease.param
			netease.param = {ids: normalizeIds(id), br, e_r: false}
		}
		query = crypto.linuxapi.encryptRequest(turn, netease.param)
	}
	else {
		if (v1) {
			const {id, ids, level, immerseType, encodeType, trialMode, header} = netease.param
			netease.param = {
				ids: normalizeIds(ids || id),
				level: level || 'exhigh',
				encodeType: encodeType || 'mp3',
				immerseType,
				trialMode,
				e_r: false,
				header
			}
		}
		else {
			const {id, br, header} = netease.param
			netease.param = {ids: normalizeIds(id), br, e_r: false, header}
		}
		query = crypto.eapi.encryptRequest(turn, netease.param)
	}
	req.url = query.url
	req.body = query.body + netease.pad
}

const tryCollect = ctx => {
	const {req, netease} = ctx
	const {trackIds, pid, op} = netease.param
	const trackId = (Array.isArray(trackIds) ? trackIds : JSON.parse(trackIds))[0]
	return request('POST', 'http://music.163.com/api/playlist/manipulate/tracks', req.headers, `trackIds=[${trackId},${trackId}]&pid=${pid}&op=${op}`).then(response => response.json())
	.then(jsonBody => {
		netease.jsonBody = jsonBody
	})
	.catch(() => {})
}

const tryLike = ctx => {
	const {req, netease} = ctx
	const {trackId} = netease.param
	let pid = 0, userId = 0
	return request('GET', 'http://music.163.com/api/v1/user/info', req.headers).then(response => response.json())
	.then(jsonBody => {
		userId = jsonBody.userPoint.userId
		return request('GET', `http://music.163.com/api/user/playlist?uid=${userId}&limit=1`, req.headers).then(response => response.json())
	})
	.then(jsonBody => {
		pid = jsonBody.playlist[0].id
		return request('POST', 'http://music.163.com/api/playlist/manipulate/tracks', req.headers, `trackIds=[${trackId},${trackId}]&pid=${pid}&op=add`).then(response => response.json())
	})
	.then(jsonBody => {
		if (new Set([200, 502]).has(jsonBody.code)) {
			netease.jsonBody = {code: 200, playlistId: pid}
		}
	})
	.catch(() => {})
}

const computeHash = task => request('GET', task.url).then(response => crypto.md5.pipe(response))

const tryMatch = ctx => {
	const {req, netease} = ctx
	const {jsonBody} = netease
	let tasks = [], target = 0

	const inject = item => {
		item.flag = 0
		if (item.url) item.url = item.url.replace(/(m\d+?)(?!c)\.music\.126\.net/, '$1c.music.126.net')
		if (netease.path.includes('url')) {
			console.log('[UNM] player item:', item.id, 'code:', item.code, 'url:', item.url ? parse(item.url).host : 'no', 'br:', item.br, 'trial:', item.freeTrialInfo ? 'yes' : 'no')
		}
		if ((item.code != 200 || !item.url || !item.br || item.freeTrialInfo) && (target == 0 || item.id == target)) {
			return match(item.id)
			.then(song => {
				item.type = song.br === 999000 ? 'flac' : 'mp3'
				item.url = global.endpoint ? `${global.endpoint}/package/${crypto.base64.encode(song.url)}/${item.id}.${item.type}` : song.url
				item.md5 = song.md5 || crypto.md5.digest(song.url)
				item.br = song.br || 128000
				item.size = song.size
				item.code = 200
				item.freeTrialInfo = null
				return song
			})
			.then(song => {
				if (!netease.path.includes('download') || song.md5) return
				const newer = (base, target) => {
					const difference =
						Array.from([base, target])
						.map(version => version.split('.').slice(0, 3).map(number => parseInt(number) || 0))
						.reduce((aggregation, current) => !aggregation.length ? current.map(element => [element]) : aggregation.map((element, index) => element.concat(current[index])), [])
						.filter(pair => pair[0] != pair[1])[0]
					return !difference || difference[0] <= difference[1]
				}
				const limit = {android: '0.0.0', osx: '0.0.0'}
				const task = {key: song.url.replace(/\?.*$/, '').replace(/(?<=kugou\.com\/)\w+\/\w+\//, '').replace(/(?<=kuwo\.cn\/)\w+\/\w+\/resource\//, ''), url: song.url}
				try {
					let {header} = netease.param
					header = typeof(header) === 'string' ? JSON.parse(header) : header
					const cookie = querystring.parse(req.headers.cookie.replace(/\s/g, ''), ';')
					const os = header.os || cookie.os, version = header.appver || cookie.appver
					if (os in limit && newer(limit[os], version))
						return cache(computeHash, task, 7 * 24 * 60 * 60 * 1000).then(value => item.md5 = value)
				}
				catch(e) {}
			})
			.catch(() => console.log('[UNM] match failed:', item.id))
		}
		else if (item.code == 200 && netease.web) {
			item.url = item.url.replace(/(m\d+?)(?!c)\.music\.126\.net/, '$1c.music.126.net')
		}
	}

	if (!Array.isArray(jsonBody.data)) {
		tasks = [inject(jsonBody.data)]
	}
	else if (netease.path.includes('download')) {
		jsonBody.data = jsonBody.data[0]
		tasks = [inject(jsonBody.data)]
	}
	else {
		target = netease.web ? 0 : parseInt(((Array.isArray(netease.param.ids) ? netease.param.ids : JSON.parse(netease.param.ids))[0] || 0).toString().replace('_0', '')) // reduce time cost
		tasks = jsonBody.data.map(item => inject(item))
	}
	return Promise.all(tasks).catch(() => {})
}

module.exports = hook
