const cache = require('../cache')
const select = require('./select')
const request = require('../request')

const HEADERS = {
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
	'referer': 'https://5sing.kugou.com/'
}
const QUALITIES = ['sq', 'hq', 'lq']

const search = keyword =>
	request('GET', `http://search.5sing.kugou.com/home/json?keyword=${encodeURIComponent(keyword)}&sort=1&page=1&filter=0&type=0`, HEADERS)
	.then(r => r.json())
	.then(body => (body && body.list) || [])

const resolve = (songId, songType) =>
	request('GET', `http://mobileapi.5sing.kugou.com/song/getSongUrl?songid=${songId}&songtype=${songType}`, HEADERS)
	.then(r => r.json())
	.then(body => {
		if (!body || !body.data) return Promise.reject()
		for (const q of QUALITIES) {
			const url = body.data[`${q}url`] || body.data[`${q}url_backup`]
			if (url && url.startsWith('http')) return url
		}
		return Promise.reject()
	})

const check = info =>
	search(info.keyword)
	.then(list => {
		if (!list.length) return Promise.reject()
		const hit = list[0]
		return resolve(hit.songId, hit.typeEname)
	})

const health = keyword =>
	check({keyword: keyword || '周杰伦', name: keyword || '周杰伦', album: {id: 0, name: ''}, artists: []})
	.then(() => true).catch(() => false)

module.exports = {check, health}
