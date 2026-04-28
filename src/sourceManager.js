const fs = require('fs')
const path = require('path')
const request = require('./request')

const CONFIG_PATH = path.join(__dirname, '..', 'source-config.json')

const catalog = [
	// china — native implementations available
	{id: 'NeteaseMusicClient', label: '网易云音乐', category: 'china', key: 'NeteaseMusicClient', defaultEnabled: true},
	{id: 'QQMusicClient',      label: 'QQ 音乐',   category: 'china', key: 'QQMusicClient',      defaultEnabled: true},
	{id: 'KugouMusicClient',   label: '酷狗音乐',   category: 'china', key: 'KugouMusicClient',   defaultEnabled: true},
	{id: 'KuwoMusicClient',    label: '酷我音乐',   category: 'china', key: 'KuwoMusicClient',    defaultEnabled: true},
	{id: 'MiguMusicClient',    label: '咪咕音乐',   category: 'china', key: 'MiguMusicClient',    defaultEnabled: true},
	{id: 'FiveSingMusicClient',label: '5SING 原创', category: 'china', key: 'FiveSingMusicClient',defaultEnabled: false},
	// global — native implementations available
	{id: 'YouTubeMusicClient', label: 'YouTube Music', category: 'global', key: 'YouTubeMusicClient', defaultEnabled: false},
	{id: 'JooxMusicClient',    label: 'JOOX',          category: 'global', key: 'JooxMusicClient',    defaultEnabled: false},
	// aggregators
	{id: 'TuneHubMusicClient', label: 'TuneHub', category: 'aggregator', key: 'TuneHubMusicClient', defaultEnabled: true},
	{id: 'JBSouMusicClient',   label: 'JBSou',   category: 'aggregator', key: 'JBSouMusicClient',   defaultEnabled: true},
]

const sourceSet = new Set(catalog.map(item => item.id))
const idToItem = catalog.reduce((result, item) => Object.assign(result, {[item.id]: item}), {})
const defaultOrder = catalog.map(item => item.id)
const defaultEnabled = catalog.reduce((result, item) => Object.assign(result, {[item.id]: !!item.defaultEnabled}), {})
const legacyAlias = {
	qq: 'QQMusicClient',
	kugou: 'KugouMusicClient',
	kuwo: 'KuwoMusicClient',
	migu: 'MiguMusicClient',
	netease: 'NeteaseMusicClient',
	joox: 'JooxMusicClient',
	youtube: 'YouTubeMusicClient',
	jbsou: 'JBSouMusicClient',
	tunehub: 'TuneHubMusicClient',
}

const safeParse = text => {
	try {
		return JSON.parse(text)
	}
	catch (e) {
		return null
	}
}

const normalize = input => {
	input = input || {}
	const enabled = Object.assign({}, defaultEnabled, input.enabled || {})
	const order = Array.isArray(input.order)
		? input.order.map(name => legacyAlias[name] || name).filter(name => sourceSet.has(name))
		: []
	const compacted = order.concat(defaultOrder.filter(name => !order.includes(name)))
	return {
		enabled: Object.keys(enabled).reduce((result, key) => sourceSet.has(key) ? Object.assign(result, {[key]: !!enabled[key]}) : result, {}),
		order: compacted
	}
}

let cached = null

const load = () => {
	if (cached) return cached
	if (!fs.existsSync(CONFIG_PATH)) {
		cached = normalize(null)
		return cached
	}
	const file = safeParse(fs.readFileSync(CONFIG_PATH, 'utf8'))
	cached = normalize(file)
	return cached
}

const save = next => {
	cached = normalize(next)
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(cached, null, 2))
	return cached
}

const getState = () => {
	const state = load()
	return {
		sources: state.order.map((id, index) => {
			const meta = idToItem[id]
			return {id, key: meta.key, label: meta.label, category: meta.category, enabled: !!state.enabled[id], index}
		}),
		order: state.order.slice(),
		enabled: Object.assign({}, state.enabled)
	}
}

const resolveMatchOrder = runtimeOrder => {
	if (Array.isArray(runtimeOrder) && runtimeOrder.length) {
		return runtimeOrder.map(name => legacyAlias[name] || name).filter(name => sourceSet.has(name)).map(id => idToItem[id].key)
	}
	const state = load()
	return state.order.filter(name => state.enabled[name]).map(id => idToItem[id].key)
}

const withTimeout = (promise, timeout = 8000) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
	])

const probes = {
	TuneHubMusicClient:  () => request('GET', 'https://api.qijieya.cn/meting/?server=netease&type=search&id=test').then(r => r.statusCode < 500),
	KugouMusicClient:    () => request('GET', 'http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=test&page=1&pagesize=1').then(r => r.json()).then(b => !!(b && b.data)),
	QQMusicClient:       () => request('POST', 'https://u.y.qq.com/cgi-bin/musicu.fcg', {'content-type': 'application/json', 'origin': 'https://y.qq.com', 'referer': 'https://y.qq.com/'}, JSON.stringify({comm:{ct:'19',cv:'1859',format:'json'},req_1:{module:'music.search.SearchCgiService',method:'DoSearchForQQMusicMobile',param:{query:'test',search_type:0,num_per_page:1,page_num:1}}})).then(r => r.json()).then(b => !!(b && b.req_1)),
	KuwoMusicClient:     () => request('GET', 'http://www.kuwo.cn/search/searchMusicBykeyWord?vipver=1&client=kt&ft=music&rformat=json&encoding=utf8&rn=1&pn=0&all=test', {'user-agent': 'Mozilla/5.0'}).then(r => r.statusCode < 500),
	MiguMusicClient:     () => request('GET', 'https://c.musicapp.migu.cn/v1.0/content/search_all.do?text=test&pageNo=1&pageSize=1&isCopyright=1&sort=1', {'host': 'c.musicapp.migu.cn', 'ua': 'Android_migu', 'version': '6.8.8', 'user-agent': 'Mozilla/5.0'}).then(r => r.statusCode < 500),
	JBSouMusicClient:    () => request('POST', 'https://www.jbsou.cn/', {'x-requested-with': 'XMLHttpRequest', 'user-agent': 'Mozilla/5.0', 'origin': 'https://www.jbsou.cn', 'referer': 'https://www.jbsou.cn/'}, 'input=test&filter=name&type=qq&page=1').then(r => r.statusCode === 200),
}

const checkSources = (providers, keyword = '周杰伦') =>
	Promise.all(catalog.map(meta => {
		const start = Date.now()
		const provider = providers[meta.key]
		const run = provider && typeof(provider.health) === 'function'
			? provider.health(keyword)
			: (probes[meta.key] ? probes[meta.key]() : Promise.resolve(null))
		return withTimeout(Promise.resolve(run), 8000)
		.then(ok => ({id: meta.id, key: meta.key, ok: ok === null ? null : !!ok, latency: Date.now() - start, error: null}))
		.catch(error => ({id: meta.id, key: meta.key, ok: false, latency: Date.now() - start, error: error.message}))
	}))

module.exports = {
	catalog,
	getState,
	save,
	resolveMatchOrder,
	checkSources
}
