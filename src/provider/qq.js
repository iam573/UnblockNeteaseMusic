const cache = require('../cache')
const insure = require('./insure')
const select = require('./select')
const request = require('../request')

const headers = {
	'origin': 'https://y.qq.com',
	'referer': 'https://y.qq.com/',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
	'cookie': process.env.QQ_COOKIE || null
}

const format = song => ({
	id: {song: song.mid || song.songmid, file: (song.file || {}).media_mid || song.mid || song.songmid},
	name: song.name || song.title || song.songname,
	duration: (song.interval || 0) * 1000,
	album: {id: (song.album || {}).mid, name: (song.album || {}).name || (song.album || {}).title || song.albumname || ''},
	artists: (song.singer || []).map(({mid, name}) => ({id: mid, name}))
})

// New search via musicu.fcg JSON POST (JSONP endpoint is defunct)
const search = info => {
	const payload = JSON.stringify({
		comm: {ct: '19', cv: '1859', format: 'json', inCharset: 'utf-8', outCharset: 'utf-8'},
		req_1: {
			module: 'music.search.SearchCgiService',
			method: 'DoSearchForQQMusicMobile',
			param: {query: info.keyword, search_type: 0, num_per_page: 20, page_num: 1, highlight: 1, grp: 1}
		}
	})
	return request('POST', 'https://u.y.qq.com/cgi-bin/musicu.fcg', {
		'content-type': 'application/json',
		'origin': 'https://y.qq.com',
		'referer': 'https://y.qq.com/'
	}, payload)
	.then(response => response.json())
	.then(jsonBody => {
		const items = (((jsonBody.req_1 || {}).data || {}).body || {}).item_song || []
		const list = items.map(format)
		const matched = select(list, info)
		return matched ? matched.id : Promise.reject()
	})
}

// Try vkeys third-party API first (no auth required)
// quality values are integers: 4=hires/flac, 3=320k, 2=192k, 1=standard
const tryVkeys = mid => {
	const qualities = [5, 4, 3, 2, 1]
	return qualities.reduce((chain, q) =>
		chain.catch(() =>
			request('GET', `https://api.vkeys.cn/v2/music/tencent/geturl?mid=${mid}&quality=${q}`)
			.then(res => res.json())
			.then(body => {
				const url = body && body.data && body.data.url
				if (!url || !url.startsWith('http')) return Promise.reject()
				return url
			})
		),
		Promise.reject()
	)
}

const tryOfficial = id => {
	const uin = ((headers.cookie || '').match(/uin=(\d+)/) || [])[1] || '0'
	const formats = [['F000', '.flac'], ['M800', '.mp3'], ['M500', '.mp3']]
		.slice((headers.cookie && select.ENABLE_FLAC) ? 0 : (headers.cookie ? 1 : 2))
	return formats.reduce((chain, [prefix, ext]) =>
		chain.catch(() => {
			const filename = prefix + id.file + id.file + ext
			const payload = JSON.stringify({
				req_0: {
					module: 'vkey.GetVkeyServer',
					method: 'CgiGetVkey',
					param: {guid: '7332953645', loginflag: 1, filename: [filename], songmid: [id.song], songtype: [0], uin, platform: '20'}
				}
			})
			return request('GET', 'https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(payload), headers)
			.then(res => res.json())
			.then(body => {
				const {sip, midurlinfo} = body.req_0.data
				return midurlinfo[0].purl ? sip[0] + midurlinfo[0].purl : Promise.reject()
			})
		}),
		Promise.reject()
	)
}

const track = id => {
	const mid = (id || {}).song || id
	return tryVkeys(mid)
	.catch(() => tryOfficial(id))
	.catch(() => insure().qq.track(id))
}

const check = info => cache(search, info).then(track)

const health = keyword =>
	search({
		keyword: keyword || '周杰伦',
		name: keyword || '周杰伦',
		album: {id: 0, name: ''},
		artists: []
	}).then(() => true).catch(() => false)

module.exports = {check, health}
