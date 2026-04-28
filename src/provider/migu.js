const cache = require('../cache')
const insure = require('./insure')
const select = require('./select')
const request = require('../request')

// Headers required by c.musicapp.migu.cn
const searchHeaders = {
	'activityid': 'v4_zt_2022_music',
	'appid': 'ce',
	'channel': '014X031',
	'host': 'c.musicapp.migu.cn',
	'origin': 'https://y.migu.cn',
	'referer': 'https://y.migu.cn/app/v4/zt/2022/music/index.html',
	'subchannel': '014X031',
	'ua': 'Android_migu',
	'version': '6.8.8',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
	'recommendstatus': '1'
}

const format = song => ({
	id: song.contentId,
	name: song.name || song.songName || '',
	album: {
		id: ((song.albums || [])[0] || {}).id,
		name: ((song.albums || [])[0] || {}).name || song.album || ''
	},
	artists: (song.singers || song.singerList || []).map(a => ({id: a.id, name: a.name}))
})

// searchSwitch is required: without it the API returns empty bestShowResultToneData
const SEARCH_SWITCH = encodeURIComponent(JSON.stringify({song: 1, album: 0, singer: 0, tagSong: 1, mvSong: 0, bestShow: 1}))

const search = info => {
	const url = 'https://c.musicapp.migu.cn/v1.0/content/search_all.do?' +
		'text=' + encodeURIComponent(info.keyword) + '&pageNo=1&pageSize=20&isCopyright=1&sort=1&searchSwitch=' + SEARCH_SWITCH
	return request('GET', url, searchHeaders)
	.then(response => response.json())
	.then(jsonBody => {
		const results = ((jsonBody.songResultData || {}).result || [])
		const list = results.map(format)
		const matched = select(list, info)
		return matched ? matched : Promise.reject()
	})
}

// Build full song info with rateFormats; needed to pick correct resourceType
const searchFull = info => {
	const url = 'https://c.musicapp.migu.cn/v1.0/content/search_all.do?' +
		'text=' + encodeURIComponent(info.keyword) + '&pageNo=1&pageSize=20&isCopyright=1&sort=1&searchSwitch=' + SEARCH_SWITCH
	return request('GET', url, searchHeaders)
	.then(response => response.json())
	.then(jsonBody => {
		const results = ((jsonBody.songResultData || {}).result || [])
		const list = results.map(s => Object.assign(format(s), {_raw: s}))
		const matched = select(list, info)
		return matched ? matched : Promise.reject()
	})
}

const TONE_FLAGS = ['SQ', 'HQ', 'PQ', 'LQ']

const track = matched => {
	const id = matched.id || matched
	const raw = (matched._raw) || {}
	// Collect available formats from search result, fallback to trying all tone flags
	const formats = []
	const allRateFormats = (raw.rateFormats || []).concat(raw.newRateFormats || []).concat(raw.audioFormats || [])
	if (allRateFormats.length) {
		allRateFormats.forEach(f => {
			if (f && f.formatType && f.resourceType && f.formatType !== 'Z3D') {
				formats.push({toneFlag: f.formatType, resourceType: f.resourceType})
			}
		})
	}
	// Always append fallback tone flags
	TONE_FLAGS.forEach(flag => {
		if (!formats.find(f => f.toneFlag === flag)) formats.push({toneFlag: flag, resourceType: 2})
	})

	return formats.reduce((chain, fmt) =>
		chain.catch(() =>
			request('GET',
				`https://c.musicapp.migu.cn/MIGUM3.0/strategy/listen-url/v2.4?` +
				`resourceType=${fmt.resourceType}&netType=01&scene=&toneFlag=${fmt.toneFlag}` +
				`&contentId=${id}&copyrightId=${id}&lowerQualityContentId=${id}`,
				searchHeaders
			)
			.then(res => res.json())
			.then(body => {
				const url = body && body.data && body.data.url
				if (!url || !url.startsWith('http')) return Promise.reject()
				return url
			})
		),
		Promise.reject()
	)
	.catch(() => insure().migu.track(id))
}

const check = info => searchFull(info).then(track)

const health = keyword =>
	search({
		keyword: keyword || '周杰伦',
		name: keyword || '周杰伦',
		album: {id: 0, name: ''},
		artists: []
	}).then(() => true).catch(() => false)

module.exports = {check, health}
