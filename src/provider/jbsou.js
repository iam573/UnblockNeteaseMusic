const cache = require('../cache')
const select = require('./select')
const request = require('../request')

const HOST = 'https://www.jbsou.cn/'
const TYPE = ['qq', 'kugou', 'kuwo', 'netease']
const HEADERS = {
	'origin': 'https://www.jbsou.cn',
	'referer': 'https://www.jbsou.cn/',
	'x-requested-with': 'XMLHttpRequest',
	'user-agent': 'Mozilla/5.0'
}

const form = object =>
	Object.keys(object).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(object[key])}`).join('&')

const parseDuration = text => {
	if (!text || typeof text !== 'string') return 0
	const part = text.split(':').map(number => parseInt(number) || 0)
	return part.length === 2 ? (part[0] * 60 + part[1]) * 1000 : 0
}

const format = song => ({
	id: song.songid,
	name: song.name,
	duration: parseDuration(song.time),
	album: {id: song.album || '', name: song.album || ''},
	artists: (song.artist || '').split('/').filter(Boolean).map((name, index) => ({id: index, name: name.trim()})),
	url: song.url ? (new URL(song.url, HOST)).href : null
})

const runSearch = (info, type) =>
	request('POST', HOST, Object.assign({'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'}, HEADERS), form({
		input: info.keyword,
		filter: 'name',
		type,
		page: 1
	}))
	.then(response => response.json())
	.then(jsonBody => {
		const list = (((jsonBody || {}).data) || []).map(format).filter(song => song.url)
		const matched = select(list, info)
		return matched ? matched.url : Promise.reject()
	})

const check = info =>
	TYPE.reduce((chain, type) => chain.catch(() => cache(meta => runSearch(meta, type), Object.assign({key: `${type}:${info.keyword}`}, info), 2 * 60 * 1000)), Promise.reject())

const health = keyword =>
	check({
		keyword: keyword || '周杰伦',
		name: keyword || '周杰伦',
		album: {id: 0, name: ''},
		artists: []
	}).then(() => true).catch(() => false)

module.exports = {check, health}
