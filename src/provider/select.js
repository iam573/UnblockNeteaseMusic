const normalize = text =>
	String(text || '')
		.toLowerCase()
		.replace(/\(.*?\)|（.*?）|\[.*?\]|【.*?】/g, ' ')
		.replace(/feat\.?|ft\.?|cover|live|伴奏|纯音乐|dj|remix|ver\.?|version/g, ' ')
		.replace(/[^\w\u4e00-\u9fa5]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()

const toTokens = text => normalize(text).split(' ').filter(Boolean)

const tokenSimilarity = (left, right) => {
	const a = new Set(toTokens(left))
	const b = new Set(toTokens(right))
	if (!a.size || !b.size) return 0
	let overlap = 0
	a.forEach(token => {
		if (b.has(token)) overlap += 1
	})
	return overlap / Math.max(a.size, b.size)
}

const overlapAny = (left, right) => {
	const a = new Set(toTokens(left))
	const b = new Set(toTokens(right))
	for (const token of a) if (b.has(token)) return true
	return false
}

const parseArtists = list =>
	(Array.isArray(list) ? list : [])
		.map(item => normalize(item && item.name))
		.filter(Boolean)

const artistScore = (candidateArtists, targetArtists) => {
	if (!candidateArtists.length || !targetArtists.length) return 0
	let score = 0
	candidateArtists.forEach(name => {
		let best = 0
		targetArtists.forEach(target => {
			best = Math.max(best, tokenSimilarity(name, target))
		})
		score += best
	})
	return score / candidateArtists.length
}

const durationScore = (candidate, target) => {
	const d1 = parseInt(candidate || 0)
	const d2 = parseInt(target || 0)
	if (!d1 || !d2) return 0.4
	const diff = Math.abs(d1 - d2)
	if (diff <= 1500) return 1
	if (diff <= 4000) return 0.85
	if (diff <= 8000) return 0.65
	if (diff <= 15000) return 0.35
	return 0
}

const computeScore = (song, info) => {
	const songName = normalize(song && song.name)
	const targetName = normalize(info && info.name)
	const songAlbum = normalize(song && song.album && song.album.name)
	const targetAlbum = normalize(info && info.album && info.album.name)
	const songArtists = parseArtists(song && song.artists)
	const targetArtists = parseArtists(info && info.artists)

	let score = 0

	// Song title is the strongest signal.
	score += tokenSimilarity(songName, targetName) * 0.5
	// Then artist overlap.
	score += artistScore(songArtists, targetArtists) * 0.3
	// Duration helps resolve same-title songs.
	score += durationScore(song && song.duration, info && info.duration) * 0.15
	// Album is weak because many providers omit or alter it.
	score += tokenSimilarity(songAlbum, targetAlbum) * 0.05

	// Hard penalties for likely mismatches.
	if (targetName && songName && !overlapAny(songName, targetName)) score -= 0.5
	if (targetArtists.length && songArtists.length) {
		const noArtistOverlap = !songArtists.some(name => targetArtists.some(target => overlapAny(name, target)))
		if (noArtistOverlap) score -= 0.35
	}

	return score
}

module.exports = (list, info) => {
	if (!Array.isArray(list) || !list.length) return null
	if (!info) return list[0]

	let best = null
	let bestScore = -Infinity
	for (const song of list) {
		const score = computeScore(song, info)
		if (score > bestScore) {
			bestScore = score
			best = song
		}
	}

	// Keep old behavior as fallback for weak metadata.
	if (!best) return list[0]
	return best
}

module.exports.ENABLE_FLAC = (process.env.ENABLE_FLAC || '').toLowerCase() === 'true'