const cache = require('../cache')
const insure = require('./insure')
const select = require('./select')
const request = require('../request')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

const format = song => {
	const rid = (song.MUSICRID || song.musicrid || '').replace(/^MUSIC_/, '')
	const dur = song.DURATION || song.duration || 0
	const artist = (song.ARTIST || song.artist || '')
	const artistId = song.ARTISTID || song.artistid || null
	return {
		id: rid,
		name: song.NAME || song.name || '',
		duration: parseInt(dur) * 1000,
		album: {id: song.ALBUMID || song.albumid, name: song.ALBUM || song.album || ''},
		artists: artist.split('&').map((name, i) => ({id: i === 0 ? artistId : null, name: name.trim()}))
	}
}

// New search endpoint — no kw_token required
const search = info => {
	const keyword = encodeURIComponent(info.keyword.replace(' - ', ''))
	const url = `http://www.kuwo.cn/search/searchMusicBykeyWord?vipver=1&client=kt&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1&show_copyright_off=1&pn=0&rn=30&all=${keyword}`
	return request('GET', url, {'user-agent': UA})
	.then(response => response.json())
	.then(jsonBody => {
		const list = (jsonBody.abslist || []).map(format)
		const matched = select(list, info)
		return matched ? matched.id : Promise.reject()
	})
}

// Third-party track APIs that don't require cookies
const trycgg = (id, level) =>
	request('GET', `https://kw-api.cenguigui.cn/?id=${id}&type=song&level=${level}&format=json`)
	.then(res => res.json())
	.then(body => {
		const url = body && body.data && body.data.url
		if (!url || !url.startsWith('http')) return Promise.reject()
		return url
	})

const trynxinxz = (id, level) =>
	request('GET', `http://music.nxinxz.com/kw.php?id=${id}&level=${level}&type=json`)
	.then(res => res.json())
	.then(body => {
		const url = body && body.data && body.data.url
		if (!url || !url.startsWith('http')) return Promise.reject()
		return url
	})

const track = id => {
	const levels = ['lossless', 'exhigh', 'high', 'standard']
	const tryLevels = (apis) =>
		levels.reduce((chain, level) =>
			chain.catch(() =>
				apis.reduce((c2, fn) => c2.catch(() => fn(id, level)), Promise.reject())
			),
			Promise.reject()
		)
	return tryLevels([trycgg, trynxinxz])
	.catch(() => insure().kuwo.track(id))
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
