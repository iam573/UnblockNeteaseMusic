const cache = require('../cache')
const select = require('./select')
const request = require('../request')

const toList = value => Array.isArray(value) ? value : []

// -- Search helpers --

const qqSearch = keyword => {
	const body = JSON.stringify({
		req_1: {
			method: 'DoSearchForQQMusicDesktop',
			module: 'music.search.SearchCgiService',
			param: {num_per_page: 10, page_num: 1, query: keyword, search_type: '0'}
		}
	})
	return request('POST', 'https://u.y.qq.com/cgi-bin/musicu.fcg',
		{'content-type': 'application/json', referer: 'https://y.qq.com/', origin: 'https://y.qq.com/'},
		body
	)
	.then(r => r.json())
	.then(jsonBody =>
		toList(((((jsonBody || {}).req_1 || {}).data || {}).body || {}).item_song)
		.map(item => ({
			id: item.mid,
			name: item.name,
			duration: parseInt(item.interval || 0) * 1000,
			album: {id: ((item.album || {}).mid) || '', name: ((item.album || {}).name) || ''},
			artists: toList(item.singer).map(s => ({id: s.mid, name: s.name})),
			root: 'qq'
		}))
	)
}

const kuwoSearch = keyword => {
	const url = 'http://www.kuwo.cn/search/searchMusicBykeyWord?vipver=1&client=kt&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1&show_copyright_off=1&pn=0&rn=10&all=' + encodeURIComponent(keyword)
	return request('GET', url, {'user-agent': 'Mozilla/5.0'})
	.then(r => r.json())
	.then(jsonBody =>
		toList((jsonBody || {}).abslist).map(item => ({
			id: (item.MUSICRID || item.musicrid || '').replace(/^MUSIC_/, ''),
			name: item.NAME || item.SONGNAME || item.name,
			duration: parseInt(item.DURATION || item.duration || 0) * 1000,
			album: {id: item.ALBUMID || '', name: item.ALBUM || ''},
			artists: (item.ARTIST || item.artist || '').split('&').filter(Boolean).map((name, i) => ({id: i, name: name.trim()})),
			root: 'kuwo'
		}))
	)
}

// meting: new format embeds song id inside the url field
const neteaseSearch = keyword => {
	const url = 'https://api.qijieya.cn/meting/?server=netease&type=search&id=' + encodeURIComponent(keyword)
	return request('GET', url)
	.then(r => r.json())
	.then(jsonBody =>
		toList(jsonBody)
		.map(item => {
			const idMatch = (item.url || '').match(/id=(\d+)/)
			const id = idMatch ? idMatch[1] : null
			return {
				id,
				name: item.name,
				duration: 0,
				album: {id: '', name: ''},
				artists: (item.artist || '').split(',').filter(Boolean).map((name, i) => ({id: i, name: name.trim()})),
				root: 'netease',
				_metingUrl: item.url
			}
		})
		.filter(item => !!item.id)
	)
}

const search = info =>
	Promise.all([
		qqSearch(info.keyword).catch(() => []),
		kuwoSearch(info.keyword).catch(() => []),
		neteaseSearch(info.keyword).catch(() => [])
	])
	.then(results => results.flat())
	.then(list => {
		const matched = select(list, info)
		return matched ? matched : Promise.reject()
	})

// -- Track helpers --

const trackQQ = id => {
	const qualities = [5, 4, 3, 2, 1]
	return qualities.reduce((chain, q) =>
		chain.catch(() =>
			request('GET', `https://api.vkeys.cn/v2/music/tencent/geturl?mid=${id}&quality=${q}`)
			.then(r => r.json())
			.then(body => {
				const url = body && body.data && body.data.url
				if (!url || !url.startsWith('http')) return Promise.reject()
				return url
			})
		),
		Promise.reject()
	)
}

const trackKuwo = id => {
	const levels = ['lossless', 'exhigh', 'high', 'standard']
	return levels.reduce((chain, level) =>
		chain.catch(() =>
			request('GET', `https://kw-api.cenguigui.cn/?id=${id}&type=song&level=${level}&format=json`)
			.then(r => r.json())
			.then(body => {
				const url = body && body.data && body.data.url
				if (!url || !url.startsWith('http')) return Promise.reject()
				return url
			})
		),
		Promise.reject()
	)
}

const trackNetease = matched => {
	const metingUrl = matched._metingUrl ||
		`https://api.qijieya.cn/meting/?server=netease&type=url&id=${matched.id}`
	return request('GET', metingUrl)
	.then(r => r.body())
	.then(body => {
		const url = body.trim()
		return (url && url.startsWith('http')) ? url : Promise.reject()
	})
}

const track = matched => {
	if (matched.root === 'qq')      return trackQQ(matched.id)
	if (matched.root === 'kuwo')    return trackKuwo(matched.id)
	if (matched.root === 'netease') return trackNetease(matched)
	return Promise.reject()
}

const check = info => cache(search, info, 3 * 60 * 1000).then(track)

const health = keyword =>
	check({
		keyword: keyword || '周杰伦',
		name: keyword || '周杰伦',
		album: {id: 0, name: ''},
		artists: []
	}).then(() => true).catch(() => false)

module.exports = {check, health}
