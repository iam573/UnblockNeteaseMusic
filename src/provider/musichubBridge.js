const providers = {
	// official chinese platforms
	NeteaseMusicClient:  require('./netease'),
	QQMusicClient:       require('./qq'),
	KugouMusicClient:    require('./kugou'),
	KuwoMusicClient:     require('./kuwo'),
	MiguMusicClient:     require('./migu'),
	// aggregators
	TuneHubMusicClient:  require('./tunehub'),
	JBSouMusicClient:    require('./jbsou'),
}

// (no fallback sources needed — all catalog entries have native implementations)

const check = (sourceKey, info) => {
	const p = providers[sourceKey]
	if (p && typeof p.check === 'function') return p.check(info)
	return Promise.reject(new Error(`no provider: ${sourceKey}`))
}

const health = (sourceKey, keyword) => {
	const p = providers[sourceKey]
	if (p && typeof p.health === 'function') return p.health(keyword)
	return Promise.resolve(false)
}

module.exports = {
	check,
	health,
	hasNative: sourceKey => !!providers[sourceKey]
}
