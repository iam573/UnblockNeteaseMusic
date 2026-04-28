const find = require('./find')
const request = require('../request')
const sourceManager = require('../sourceManager')
const musichubBridge = require('./musichubBridge')

const provider = sourceManager.catalog.reduce((result, item) => Object.assign(result, {
	[item.key]: {
		label: item.label,
		check: info => musichubBridge.check(item.key, info),
		health: keyword => musichubBridge.health(item.key, keyword)
	}
}), {})

const fmt = bytes => bytes > 0 ? `${(bytes / 1048576).toFixed(2)}MB` : '?'
const pad = (s, n) => String(s).padEnd(n)

// Estimate actual audio duration (seconds) from file size + detected bitrate.
// Returns null when bitrate is unknown (can't reliably estimate).
const estimatedAudioDuration = song => {
	if (!song.size || song.size <= 0) return null
	if (!song.br || song.br <= 0 || song.br >= 999000) return null // FLAC / unknown br
	return song.size / (song.br / 8) // bytes / (bits-per-sec / 8) = seconds
}

// Minimum expected file size (bytes) for a full song at ~64kbps.
// Anything below this threshold is almost certainly a short trial clip.
const minExpectedBytes = (expectedMs, minBr = 64000) =>
	expectedMs > 0 ? (expectedMs / 1000) * (minBr / 8) * 0.7 : 0

// A result is a trial if:
//   1. Estimated duration (size/br) is < 70% of expected full length, OR
//   2. Bitrate is unknown but file size is below the floor for ~64kbps × 70%
const isTrial = (song, expectedMs) => {
	if (!expectedMs) return false
	const est = estimatedAudioDuration(song)
	if (est !== null) return est < (expectedMs / 1000) * 0.7
	// br unknown — fall back to absolute size floor
	if (song.size > 0) return song.size < minExpectedBytes(expectedMs)
	return false
}

// race: resolve with the first source that returns a valid playable URL.
// Results are stored in pre-allocated slots (indexed by candidate position)
// so the caller can always print them in the original order.
const raceCheck = (candidates, info, slots) => new Promise((resolve, reject) => {
	let remaining = candidates.length
	if (!remaining) return reject()
	candidates.forEach((name, idx) => {
		provider[name].check(info)
		.then(url => {
			if (!url) { slots[idx] = {state: 'no_url'}; return Promise.reject() }
			slots[idx] = {state: 'checking', url}
			return check(url)
		})
		.then(song => {
			if (!song || !song.url) { slots[idx] = {state: 'dead', url: slots[idx].url}; return Promise.reject() }
			if (isTrial(song, info.duration)) {
				slots[idx] = {
					state: 'trial',
					url: slots[idx].url,
					est: Math.round(estimatedAudioDuration(song)),
					full: Math.round((info.duration || 0) / 1000),
					size: song.size
				}
				return Promise.reject()
			}
			slots[idx] = {state: 'ok', url: song.url, size: song.size, br: song.br}
			resolve({song, source: name, idx})
		})
		.catch(() => {
			if (!slots[idx]) slots[idx] = {state: 'failed'}
			if (--remaining === 0) reject()
		})
	})
})

const slotLine = (idx, label, slot) => {
	const num = String(idx + 1).padStart(2)
	const lbl = pad(label, 16)
	if (!slot)                  return `  ${num}. ${lbl} -`
	if (slot.state === 'no_url') return `  ${num}. ${lbl} ✗ no url`
	if (slot.state === 'failed') return `  ${num}. ${lbl} ✗ error`
	if (slot.state === 'dead')   return `  ${num}. ${lbl} ✗ url dead   ${slot.url}`
	if (slot.state === 'trial')  return `  ${num}. ${lbl} ✗ trial ~${slot.est}s/${slot.full}s ${fmt(slot.size)}   ${slot.url}`
	if (slot.state === 'checking') return `  ${num}. ${lbl} ↓ ${slot.url}`
	if (slot.state === 'ok')     return `  ${num}. ${lbl} ✓ ${fmt(slot.size)} ${slot.br ? slot.br/1000+'kbps' : '?'}   ${slot.url}`
	return `  ${num}. ${lbl} ?`
}

const printMatch = (info, candidate, slots, footer) => {
	const dur = info.duration ? `${Math.round(info.duration / 1000)}s` : '?s'
	const lines = [
		`[UNM] ┌─ match [${info.id}] ${info.name}  (${dur})`,
		`[UNM] │  platforms (${candidate.length}): ${candidate.map(n => (provider[n] && provider[n].label) || n).join(' · ')}`,
		`[UNM] │  results:`,
		...candidate.map((name, idx) => slotLine(idx, (provider[name] && provider[name].label) || name, slots[idx])),
		footer
	]
	console.log(lines.join('\n'))
}

const match = (id, source) => {
	let meta = {}, slots = [], candidate = []
	candidate = sourceManager.resolveMatchOrder(source || global.source).filter(name => name in provider)
	slots = new Array(candidate.length).fill(null)
	return find(id)
	.then(info => {
		meta = info
		return raceCheck(candidate, info, slots)
	})
	.then(({song, source}) => {
		const label = (provider[source] && provider[source].label) || source
		printMatch(meta, candidate, slots,
			`[UNM] └─ ✓ matched by ${label}  size:${fmt(song.size)}  br:${song.br ? song.br/1000+'kbps' : '?'}\n         ${song.url}`)
		return song
	})
	.catch(err => {
		printMatch(meta, candidate, slots, `[UNM] └─ ✗ all platforms failed`)
		return Promise.reject(err)
	})
}

const check = url => {
	const song = {size: 0, br: null, url: null, md5: null}
	return Promise.race([request('GET', url, {'range': 'bytes=0-8191'}), new Promise((_, reject) => setTimeout(() => reject(504), 5 * 1000))])
	.then(response => {
		if (!response.statusCode.toString().startsWith('2')) return Promise.reject()
		if (url.includes('qq.com'))
			song.md5 = response.headers['server-md5']
		else if (url.includes('xiami.net') || url.includes('qianqian.com'))
			song.md5 = response.headers['etag'].replace(/"/g, '').toLowerCase()
		song.size = parseInt((response.headers['content-range'] || '').split('/').pop() || response.headers['content-length']) || 0
		song.url = response.url.href
		return response.headers['content-length'] === '8192' ? response.body(true) : Promise.reject()
	})
	.then(data => {
		const bitrate = decode(data)
		song.br = (bitrate && !isNaN(bitrate)) ? bitrate * 1000 : null
	})
	.catch(() => {})
	.then(() => song)
}

const decode = buffer => {
	const map = {
		3: {
			3: ['free', 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 'bad'],
			2: ['free', 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 'bad'],
			1: ['free', 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 'bad']
		},
		2: {
			3: ['free', 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 'bad'],
			2: ['free', 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 'bad']
		}
	}
	map[2][1] = map[2][2]
	map[0] = map[2]

	let pointer = 0
	if (buffer.slice(0, 4).toString() === 'fLaC') return 999
	if (buffer.slice(0, 3).toString() === 'ID3') {
		pointer = 6
		const size = buffer.slice(pointer, pointer + 4).reduce((summation, value, index) => summation + (value & 0x7f) << (7 * (3 - index)), 0)
		pointer = 10 + size
	}
	const header = buffer.slice(pointer, pointer + 4)

	// https://www.allegro.cc/forums/thread/591512/674023
	if (
		header.length === 4 &&
		header[0] === 0xff &&
		((header[1] >> 5) & 0x7) === 0x7 &&
		((header[1] >> 1) & 0x3) !== 0 &&
		((header[2] >> 4) & 0xf) !== 0xf &&
		((header[2] >> 2) & 0x3) !== 0x3
	) {
		const version = (header[1] >> 3) & 0x3
		const layer = (header[1] >> 1) & 0x3
		const bitrate = header[2] >> 4
		return map[version][layer][bitrate]
	}
}

match.provider = provider
match.sourceManager = sourceManager

module.exports = match