const cache = require('../cache')
const select = require('./select')
const request = require('../request')

const API = process.env.PYNCMD_API || 'https://music-api.gdstudio.xyz/api.php'
const SEARCH_SOURCES = ['tencent', 'kuwo', 'migu', 'kugou', 'netease']
const URL_SOURCES = ['tencent', 'kuwo', 'migu', 'kugou', 'netease']
const BR_LIST = [999, 740, 320, 192, 128]

const toList = value => Array.isArray(value) ? value : []
const asText = value => (value == null ? '' : String(value))

const parseDurationMs = value => {
	const n = parseInt(value || 0)
	if (!n) return 0
	// Some APIs return ms, some return sec.
	return n > 1000 ? n : n * 1000
}

const normalizeSong = (raw, source) => {
	const artistsRaw = raw.artist || raw.author || raw.singer || raw.artists || ''
	const artists = Array.isArray(artistsRaw)
		? artistsRaw
		: asText(artistsRaw).split(/[\/,&]|、/g).filter(Boolean)

	return {
		id: raw.id || raw.songid || raw.mid || raw.musicrid,
		name: asText(raw.name || raw.title || raw.songname),
		duration: parseDurationMs(raw.duration || raw.time || raw.interval || raw.dt),
		album: {id: asText(raw.albumid || ''), name: asText(raw.album || raw.alname || '')},
		artists: artists.map((name, idx) => ({id: idx, name: asText(name).trim()})),
		_source: source
	}
}

const searchBySource = (keyword, source) =>
	request('GET', `${API}?types=search&source=${encodeURIComponent(source)}&name=${encodeURIComponent(keyword)}&count=20`)
	.then(r => r.json())
	.then(body => {
		const list = toList(body).map(item => normalizeSong(item, source)).filter(song => song.id && song.name)
		return list
	})

const search = info =>
	Promise.all(SEARCH_SOURCES.map(source => searchBySource(info.keyword, source).catch(() => [])))
	.then(results => results.flat())
	.then(list => {
		const matched = select(list, info)
		return matched ? matched : Promise.reject()
	})

const fetchUrl = (source, id, br) =>
	request('GET', `${API}?types=url&source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&br=${encodeURIComponent(br)}`)
	.then(r => r.json())
	.then(body => {
		const url = body && body.url
		return (url && /^https?:\/\//.test(url)) ? url : Promise.reject()
	})

const track = matched =>
	URL_SOURCES.reduce((sourceChain, source) =>
		sourceChain.catch(() =>
			BR_LIST.reduce((bitrateChain, br) =>
				bitrateChain.catch(() => fetchUrl(source, matched.id, br)),
				Promise.reject()
			)
		),
		Promise.reject()
	)

const check = info => cache(search, info, 2 * 60 * 1000).then(track)

const health = keyword =>
	check({
		keyword: keyword || '周杰伦',
		name: keyword || '周杰伦',
		album: {id: 0, name: ''},
		artists: []
	}).then(() => true).catch(() => false)

module.exports = {check, health}
