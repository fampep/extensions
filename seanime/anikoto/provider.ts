// ─── Types ────────────────────────────────────────────────────────────────────

type Track = { file?: string; label?: string; kind?: string; default?: boolean }
type ServerLink = { name: string; linkId: string }
type Embed = { origin: string; pageUrl: string; file: string; tracks: Track[]; labeled: { url: string; quality: string }[] }
type SiteEpisode = { number: number; ids: string; slug: string; hasSub: boolean; hasDub: boolean }

// ─────────────────────────────────────────────────────────────────────────────
//
//  Anikoto (anikoto.cz) — site scrape → server AJAX → MegaPlay getSources.
//  Ported from the Anikoto API's `providers/anikoto.rs`.
//
//  Flow:
//    1. GET /ajax/anime/search?keyword=…            → { result: { html } }  a.item cards
//    2. GET /watch/{slug}                           → #watch-main[data-id]
//    3. GET /ajax/episode/list/{id}?style=multi     → a[data-num][data-sub][data-dub][data-ids]
//    4. GET /ajax/server/list?servers={dataIds}     → .type[data-type=sub|dub] li[data-link-id]
//    5. GET /ajax/server?get={linkId}               → { result: { url } }  MegaPlay embed
//    6. GET {embed}                                 → #megaplay-player[data-id]
//    7. GET {origin}/stream/getSources?id={dataId}  → { sources: { file }, tracks: [...] }
//
//  Every request runs through the cookie jar below: Set-Cookie is read off each
//  response, merged into $store and replayed, so the site's session survives
//  across calls exactly like it does in a browser.
//
// ─────────────────────────────────────────────────────────────────────────────

class Provider {
    private baseUrl          = "{{baseUrl}}"
    private preferredQuality = "{{preferred_quality}}"
    private fallbackBase     = "https://anikoto.cz"
    private mirrors = [
        "https://anikoto.cz",
        "https://anikototv.to",
        "https://anikoto.me",
        "https://anikoto.net",
        "https://anikototv.se",
    ]
    private megaplayBase = "https://megaplay.buzz"

    private cacheTtl       = 900_000    // 15 min — watch pages, episode lists
    private serverCacheTtl = 300_000    // 5 min  — per-episode server lists
    private playCacheTtl   = 120_000    // 2 min  — playability probes
    private jarTtl         = 3_600_000  // 60 min — cookie jar lifetime

    private userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

    // ─── Mirror resolution ────────────────────────────────────────────────────

    private configuredBase(): string {
        const raw = this.baseUrl
        const usable = raw && raw.indexOf("{{") === -1 ? raw : this.fallbackBase
        return usable.replace(/\/+$/, "")
    }

    private async resolveBase(): Promise<string> {
        const all = [this.configuredBase(), ...this.mirrors]
            .map((u) => u.replace(/\/+$/, ""))
            .filter((u, i, arr) => arr.indexOf(u) === i)

        if (all.length === 1) return all[0]

        const cached = $store.get<string>("anikoto:base")
        if (cached && all.indexOf(cached) !== -1) {
            try {
                const probe = await fetch(cached, { method: "HEAD", timeout: 5 })
                if (probe.ok) return cached
            } catch (_e) {}
            $store.set("anikoto:base", "")
        }

        const winner = await this.raceMirrors(all)
        const base   = winner ?? all[0]
        $store.set("anikoto:base", base)
        return base
    }

    private raceMirrors(candidates: string[]): Promise<string | undefined> {
        return new Promise((resolve) => {
            let settled = false
            let pending = candidates.length
            for (const c of candidates) {
                fetch(c, { method: "HEAD", timeout: 8 })
                    .then((res) => { if (!settled && res.ok) { settled = true; resolve(c) } })
                    .catch(() => {})
                    .finally(() => { pending--; if (pending === 0 && !settled) resolve(undefined) })
            }
        })
    }

    /** Set by every entry point before any scraping happens. */
    private base(): string {
        const cached = $store.get<string>("anikoto:base")
        return cached ? cached : this.configuredBase()
    }

    // ─── Cookie jar ───────────────────────────────────────────────────────────

    private jarKey(): string { return `anikoto:jar:${this.base()}` }

    private loadJar(): Record<string, string> {
        const jar = this.readCache<Record<string, string>>(this.jarKey(), this.jarTtl)
        return jar ? jar : {}
    }

    private cookieHeader(): string {
        const jar = this.loadJar()
        const parts: string[] = []
        for (const name in jar) {
            const value = jar[name]
            if (name && value) parts.push(`${name}=${value}`)
        }
        return parts.join("; ")
    }

    /** Merge every Set-Cookie of a response into the jar (empty value / Max-Age=0 deletes). */
    private absorbCookies(res: FetchResponse): void {
        const found: Record<string, string> = {}
        let any = false

        try {
            const parsed = res.cookies
            for (const name in parsed) {
                if (!name) continue
                found[name] = parsed[name]
                any = true
            }
        } catch (_e) {}

        try {
            const raw = res.rawHeaders
            for (const key in raw) {
                if (key.toLowerCase() !== "set-cookie") continue
                for (const line of raw[key] || []) {
                    const pair = line.split(";")[0] || ""
                    const eq   = pair.indexOf("=")
                    if (eq <= 0) continue
                    const name = pair.slice(0, eq).trim()
                    if (!name) continue
                    const dead = /max-age\s*=\s*0/i.test(line) || /expires\s*=\s*thu,\s*01[ -]jan[ -]1970/i.test(line)
                    found[name] = dead ? "" : pair.slice(eq + 1).trim()
                    any = true
                }
            }
        } catch (_e) {}

        if (!any) return

        const jar = this.loadJar()
        let changed = false
        for (const name in found) {
            const value = found[name]
            if (!value) {
                if (jar[name] !== undefined) { delete jar[name]; changed = true }
                continue
            }
            if (jar[name] !== value) { jar[name] = value; changed = true }
        }
        if (changed) this.writeCache(this.jarKey(), jar)
    }

    // ─── Fetch ────────────────────────────────────────────────────────────────

    private headersFor(kind: "page" | "ajax", referer?: string): Record<string, string> {
        const h: Record<string, string> = {
            "User-Agent":      this.userAgent,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer":         referer || `${this.base()}/`,
        }

        if (kind === "ajax") {
            h["Accept"]           = "application/json, text/javascript, */*; q=0.01"
            h["X-Requested-With"] = "XMLHttpRequest"
        } else {
            h["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
            h["upgrade-insecure-requests"] = "1"
        }

        const cookie = this.cookieHeader()
        if (cookie) h["Cookie"] = cookie

        return h
    }

    private async request(url: string, opts: { kind: "page" | "ajax"; referer?: string; timeout?: number; tries?: number }): Promise<FetchResponse> {
        const tries = opts.tries ?? 2
        let lastErr: unknown

        for (let i = 0; i < tries; i++) {
            try {
                const res = await fetch(url, {
                    headers: this.headersFor(opts.kind, opts.referer),
                    timeout: opts.timeout ?? 14,
                })
                this.absorbCookies(res)
                if (res.ok || res.status < 500 || i === tries - 1) return res
            } catch (e) {
                lastErr = e
                if (i === tries - 1) throw e
            }
        }
        throw lastErr
    }

    private async getText(url: string, opts: { kind: "page" | "ajax"; referer?: string; timeout?: number }): Promise<string> {
        const res = await this.request(url, opts)
        if (!res.ok) throw new Error(`[anikoto] HTTP ${res.status} for ${url}`)
        const body = res.text()
        if (body.toLowerCase().indexOf("just a moment") !== -1) throw new Error(`[anikoto] Cloudflare challenge on ${url}`)
        return body
    }

    /** Site AJAX always answers `{ status, result }`, where result is html or `{ html }`. */
    private async getAjax(url: string, referer: string, timeout = 14): Promise<{ status: number; result: any }> {
        const text = await this.getText(url, { kind: "ajax", referer, timeout })
        try {
            return JSON.parse(text) as { status: number; result: any }
        } catch (_e) {
            throw new Error(`[anikoto] malformed AJAX JSON from ${url}`)
        }
    }

    private ajaxHtml(payload: { status: number; result: any }): string {
        const result = payload?.result
        if (typeof result === "string") return result
        if (result && typeof result.html === "string") return result.html
        return ""
    }

    // ─── Settings ─────────────────────────────────────────────────────────────

    getSettings(): Settings {
        return {
            episodeServers: ["Auto", "HD-1", "Vidstream-2", "VidPlay-1"],
            supportsDub: true,
        }
    }

    // ─── Search ───────────────────────────────────────────────────────────────

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        await this.resolveBase()

        const audio   = opts.dub ? "dub" : "sub"
        const queries = this.searchQueries(opts)
        const results: SearchResult[]       = []
        const seen: Record<string, boolean> = {}
        let anyOk = false

        for (const q of queries) {
            let html = ""
            try {
                const payload = await this.getAjax(`${this.base()}/ajax/anime/search?keyword=${encodeURIComponent(q)}`, `${this.base()}/`)
                anyOk = true
                html  = this.ajaxHtml(payload)
            } catch (_e) { continue }
            if (!html) continue

            for (const hit of this.parseSearchCards(html)) {
                if (seen[hit.url]) continue
                seen[hit.url] = true
                results.push({
                    id:       this.encodeId(hit.url, audio, opts.media.id),
                    title:    hit.title,
                    url:      hit.url,
                    // The site only exposes per-episode sub/dub flags, which are
                    // read (and enforced) in findEpisodes.
                    subOrDub: "both",
                })
            }
        }

        if (!anyOk) throw new Error(`[anikoto] search failed for "${queries[0]}" — all mirrors unreachable`)
        return results
    }

    private searchQueries(opts: SearchOptions): string[] {
        return [opts.query, opts.media.romajiTitle, opts.media.englishTitle]
            .map((t) => (t || "").trim())
            .filter((q, i, arr) => q.length > 0 && arr.indexOf(q) === i)
    }

    private parseSearchCards(html: string): { url: string; title: string }[] {
        const out: { url: string; title: string }[] = []
        const $ = LoadDoc(html)

        let cards = $("a.item")
        if (cards.length() === 0) cards = $('a[href*="/watch/"]')

        cards.each((_i, a) => {
            const href = a.attr("href") || ""
            if (href.indexOf("/watch/") === -1) return
            const url = this.watchUrl(href)

            const nameEl = a.find(".name").first()
            const title  = (nameEl.text() || nameEl.attr("data-jp") || a.find("img").first().attr("alt") || "").trim()
            if (!title) return

            out.push({ url, title })
        })

        return out
    }

    // ─── Episodes ─────────────────────────────────────────────────────────────

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        await this.resolveBase()

        const meta     = this.decodeId(id)
        const watchUrl = this.watchUrl(meta.base)

        const cacheKey = `anikoto:eps:${watchUrl}:${meta.audio}:${meta.anilistId}`
        const cached   = this.readCache<EpisodeDetails[]>(cacheKey)
        if (cached && cached.length > 0) return cached

        const page = await this.getText(watchUrl, { kind: "page", referer: `${this.base()}/` })
        const siteId = this.parseWatchId(page)
        if (!siteId) throw new Error(`[anikoto] findEpisodes: no #watch-main data-id in ${watchUrl}`)

        const payload = await this.getAjax(`${this.base()}/ajax/episode/list/${siteId}?style=multi`, watchUrl)
        const listHtml = this.ajaxHtml(payload)
        if (!listHtml) throw new Error(`[anikoto] episode list empty for series ${siteId}`)

        const rows = this.parseEpisodeList(listHtml)
        if (rows.length === 0) throw new Error(`[anikoto] no episodes parsed for series ${siteId}`)

        const wantDub  = meta.audio === "dub"
        const usable   = rows.filter((r) => (wantDub ? r.hasDub : r.hasSub))
        const selected = usable.length > 0 ? usable : rows
        if (wantDub && usable.length === 0) throw new Error(`[anikoto] no dub episodes for ${watchUrl}`)

        const episodes: EpisodeDetails[] = selected.map((r) => ({
            id:     this.encodeId(`${r.ids}~${watchUrl}`, meta.audio, meta.anilistId),
            number: r.number,
            url:    `${watchUrl}/ep-${r.slug || r.number}`,
            title:  `Episode ${r.number}`,
        }))

        episodes.sort((a, b) => a.number - b.number)
        this.writeCache(cacheKey, episodes)
        return episodes
    }

    private parseWatchId(html: string): string {
        const $ = LoadDoc(html)
        const fromDoc = $("#watch-main").first().attr("data-id")
            || $("[id*='watch'][data-id]").first().attr("data-id")
        if (fromDoc) return fromDoc
        const m = html.match(/id=["']watch-main["'][^>]*\bdata-id=["'](\d+)["']/i)
        return m ? m[1] : ""
    }

    private parseEpisodeList(html: string): SiteEpisode[] {
        const out: SiteEpisode[] = []
        const seen: Record<string, boolean> = {}
        const $ = LoadDoc(html)

        let nodes = $("a[data-ids]")
        if (nodes.length() === 0) nodes = $("ul.ep-range li > a")

        nodes.each((i, a) => {
            const ids = a.attr("data-ids")
            if (!ids) return
            if (seen[ids]) return
            seen[ids] = true

            const parsed = parseInt(a.attr("data-num") || "", 10)
            const number = isNaN(parsed) ? i + 1 : parsed
            if (number <= 0) return

            out.push({
                number,
                ids,
                slug:   a.attr("data-slug") || String(number),
                hasSub: (a.attr("data-sub") || "") === "1",
                hasDub: (a.attr("data-dub") || "") === "1",
            })
        })

        // Older markup omits data-sub/data-dub entirely — treat those as sub-only.
        const flagged = out.some((e) => e.hasSub || e.hasDub)
        if (!flagged) for (const e of out) e.hasSub = true

        return out
    }

    // ─── Servers ──────────────────────────────────────────────────────────────

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        await this.resolveBase()

        const meta = this.decodeId(episode.id)
        const tilde = meta.base.indexOf("~")
        if (tilde === -1) throw new Error(`[anikoto] malformed episode id "${episode.id}"`)

        const dataIds  = meta.base.slice(0, tilde)
        const watchUrl = meta.base.slice(tilde + 1)
        const referer  = `${watchUrl}/ep-${episode.number}`

        const links = await this.serverLinks(dataIds, meta.audio, watchUrl, referer)
        if (links.length === 0) throw new Error(`[anikoto] no ${meta.audio} servers for episode ${episode.number}`)

        const isAuto = !server || server === "Auto" || server === "default"

        if (!isAuto) {
            const picked = links.find((l) => l.name.toLowerCase() === server.toLowerCase())
            if (!picked) throw new Error(`[anikoto] server "${server}" not available for episode ${episode.number}`)
            return this.resolveServer(picked, meta.audio, referer)
        }

        const settled  = await Promise.allSettled<EpisodeServer>(links.map((l) => this.resolveServer(l, meta.audio, referer)))
        const resolved = settled
            .filter((r): r is PromiseFulfilledResult<EpisodeServer> => r.status === "fulfilled")
            .map((r) => r.value)
        if (resolved.length === 0) throw new Error(`[anikoto] all servers failed for episode ${episode.number}`)

        const playable = await Promise.allSettled(resolved.map((s) => this.isPlayable(s)))
        const winIdx   = playable.findIndex((r) => r.status === "fulfilled" && r.value)
        return winIdx !== -1 ? resolved[winIdx] : resolved[0]
    }

    private async serverLinks(dataIds: string, audio: string, watchUrl: string, referer: string): Promise<ServerLink[]> {
        const cacheKey = `anikoto:slist:${dataIds}:${audio}`
        const cached   = this.readCache<ServerLink[]>(cacheKey, this.serverCacheTtl)
        if (cached && cached.length > 0) return cached

        const payload = await this.getAjax(`${this.base()}/ajax/server/list?servers=${encodeURIComponent(dataIds)}`, referer || watchUrl)
        if (payload?.status && payload.status !== 200) throw new Error(`[anikoto] server list status ${payload.status}`)

        const html = this.ajaxHtml(payload)
        if (!html) throw new Error("[anikoto] server list empty")

        // Dub falls back to the sub block, matching the API's behaviour.
        let links = this.collectServers(html, audio === "dub" ? "dub" : "sub")
        if (links.length === 0 && audio === "dub") links = this.collectServers(html, "sub")
        if (links.length === 0) links = this.collectServers(html, "")

        const capped = links.slice(0, 6)
        if (capped.length > 0) this.writeCache(cacheKey, capped)
        return capped
    }

    private collectServers(html: string, type: string): ServerLink[] {
        const out: ServerLink[] = []
        const seen: Record<string, boolean> = {}
        const $ = LoadDoc(html)

        const selector = type
            ? `.servers .type[data-type="${type}"] li[data-link-id]`
            : ".servers li[data-link-id]"

        $(selector).each((_i, li) => {
            const linkId = li.attr("data-link-id")
            const name   = li.text().trim()
            if (!linkId || seen[linkId]) return
            seen[linkId] = true
            out.push({ name: name || "Anikoto", linkId })
        })

        return out
    }

    // ─── Source resolution ────────────────────────────────────────────────────

    private async resolveServer(link: ServerLink, audio: string, referer: string): Promise<EpisodeServer> {
        const payload = await this.getAjax(`${this.base()}/ajax/server?get=${encodeURIComponent(link.linkId)}`, referer)
        if (payload?.status && payload.status !== 200) throw new Error(`[anikoto] server get status ${payload.status}`)

        const embedUrl = payload?.result?.url
        if (!embedUrl || typeof embedUrl !== "string" || embedUrl.indexOf("http") !== 0) {
            throw new Error(`[anikoto] no embed url for server ${link.name}`)
        }

        const embed     = await this.resolveEmbed(embedUrl, referer)
        const headers   = { "User-Agent": this.userAgent, "Referer": `${embed.origin}/`, "Origin": embed.origin }
        const subtitles = audio === "dub" ? [] : this.buildSubtitles(embed.tracks)

        let videoSources: VideoSource[] = []

        // MegaPlay sometimes hands back a labelled ladder itself; otherwise expand the manifest.
        if (embed.labeled.length > 1) {
            for (const item of embed.labeled) {
                videoSources.push({ url: item.url, type: this.sourceType(item.url), quality: item.quality, subtitles })
            }
        } else {
            try {
                const manifest = await fetch(embed.file, { headers, timeout: 8 })
                if (manifest.ok) videoSources = this.parseM3U8Qualities(manifest.text(), embed.file, subtitles)
            } catch (_e) {}
        }

        if (videoSources.length === 0) {
            videoSources.push({ url: embed.file, type: this.sourceType(embed.file), quality: "default", subtitles })
        }

        return {
            server: link.name,
            headers,
            videoSources: this.applyQualityPreference(videoSources),
        }
    }

    private async resolveEmbed(embedUrl: string, referer: string): Promise<Embed> {
        let html    = await this.getText(embedUrl, { kind: "page", referer, timeout: 12 })
        let origin  = this.originOf(embedUrl, this.megaplayBase)
        let pageUrl = embedUrl
        let dataId  = this.parseDataId(html)

        // Some embeds only host a nested /stream/ iframe.
        if (!dataId) {
            const m = html.match(/<iframe[^>]+\bsrc=["']([^"']*\/stream\/[^"']*)["']/i)
            if (m) {
                let inner = m[1]
                if (inner.indexOf("//") === 0) inner = `https:${inner}`
                else if (inner.indexOf("/") === 0) inner = `${origin}${inner}`
                try {
                    html    = await this.getText(inner, { kind: "page", referer: embedUrl, timeout: 12 })
                    origin  = this.originOf(inner, origin)
                    pageUrl = inner
                    dataId  = this.parseDataId(html)
                } catch (_e) {}
            }
        }

        // Last resort: the id is in the embed path itself (…/stream/s-5/1464/sub).
        if (!dataId) {
            const m = embedUrl.match(/\/stream\/s-\d+\/([^/]+)\//i)
            if (m && this.isValidDataId(m[1])) dataId = m[1]
        }

        if (!dataId) throw new Error(`[anikoto] MegaPlay data-id missing in ${embedUrl}`)

        const res = await fetch(`${origin}/stream/getSources?id=${encodeURIComponent(dataId)}`, {
            headers: {
                "User-Agent":       this.userAgent,
                "Referer":          pageUrl,
                "Origin":           origin,
                "Accept":           "*/*",
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout: 12,
        })
        this.absorbCookies(res)
        if (!res.ok) throw new Error(`[anikoto] getSources HTTP ${res.status}`)

        const data = res.json<{ sources?: any; tracks?: Track[] }>()
        const list: any[] = Array.isArray(data?.sources) ? data.sources : data?.sources ? [data.sources] : []

        const labeled: { url: string; quality: string }[] = []
        for (const s of list) {
            const url = s?.file || s?.url
            if (typeof url !== "string" || url.indexOf("http") !== 0) continue
            labeled.push({ url, quality: s?.quality || s?.label || "Stream" })
        }
        if (labeled.length === 0) throw new Error("[anikoto] MegaPlay file missing")

        return { origin, pageUrl, file: labeled[0].url, tracks: data?.tracks || [], labeled }
    }

    private parseDataId(html: string): string {
        const $ = LoadDoc(html)
        const fromPlayer = $("#megaplay-player").first().attr("data-id")
        if (fromPlayer && this.isValidDataId(fromPlayer)) return fromPlayer

        let found = ""
        $("[data-id]").each((_i, el) => {
            if (found) return
            const v = el.attr("data-id")
            if (v && this.isValidDataId(v)) found = v
        })
        if (found) return found

        const m = html.match(/data-id=["']([^"']+)["']/i)
        return m && this.isValidDataId(m[1]) ? m[1] : ""
    }

    private isValidDataId(id: string): boolean {
        return !!id && id.length <= 256 && /^[A-Za-z0-9._-]+$/.test(id)
    }

    // ─── Subtitles ────────────────────────────────────────────────────────────

    private buildSubtitles(tracks: Track[] | undefined): VideoSubtitle[] {
        if (!tracks || tracks.length === 0) return []

        const collected: VideoSubtitle[]         = []
        const seenLabel: Record<string, boolean> = {}
        let englishIdx = -1
        let defaultIdx = -1

        for (const t of tracks) {
            const raw = t?.file
            if (!raw || raw.indexOf("http") !== 0) continue
            const kind = t.kind || "captions"
            if (kind !== "captions" && kind !== "subtitles") continue

            const label = (t.label || "English").trim()
            const key   = label.toLowerCase()
            if (seenLabel[key]) continue
            seenLabel[key] = true

            const idx = collected.length
            collected.push({
                id:        `${key.replace(/[^a-z0-9]/g, "") || "sub"}-${idx}`,
                url:       this.fixSubtitleUrl(raw),
                language:  label,
                isDefault: false,
            })
            if (englishIdx === -1 && key.indexOf("eng") !== -1) englishIdx = idx
            if (defaultIdx === -1 && t.default === true) defaultIdx = idx
        }

        if (collected.length === 0) return collected

        const pick = englishIdx !== -1 ? englishIdx : defaultIdx !== -1 ? defaultIdx : 0
        collected[pick].isDefault = true
        return [collected[pick], ...collected.filter((_s, i) => i !== pick)]
    }

    /** Some track URLs drop the `/subtitles/` path segment the CDN needs. */
    private fixSubtitleUrl(file: string): string {
        if (file.indexOf("/subtitles/") !== -1) return file
        const m = file.match(/^(https?:\/\/[^/]*nekostream\.site\/[0-9a-f]{16,}\/)([^/?#]+\.(?:vtt|ass|srt))/i)
        return m ? `${m[1]}subtitles/${m[2]}` : file
    }

    // ─── Manifest / quality ───────────────────────────────────────────────────

    private sourceType(url: string): VideoSourceType {
        if (url.indexOf(".m3u8") !== -1) return "m3u8"
        if (url.indexOf(".mp4") !== -1) return "mp4"
        return "unknown"
    }

    private parseM3U8Qualities(manifest: string, masterUrl: string, subtitles: VideoSubtitle[]): VideoSource[] {
        const sources: VideoSource[] = []
        const lines  = manifest.split(/\r?\n/)
        const dirUrl = masterUrl.substring(0, masterUrl.lastIndexOf("/"))

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim()
            if (!line.startsWith("#EXT-X-STREAM-INF")) continue

            const resMatch     = line.match(/RESOLUTION=\d+x(\d+)/i)
            const qualityLabel = resMatch ? `${resMatch[1]}p` : "Adaptive"

            let nextLine = ""
            while (i + 1 < lines.length) {
                i++
                nextLine = lines[i].trim()
                if (nextLine && !nextLine.startsWith("#")) break
            }
            if (!nextLine) continue

            let absolute = nextLine
            if (nextLine.indexOf("http://") !== 0 && nextLine.indexOf("https://") !== 0) {
                absolute = nextLine.indexOf("/") === 0
                    ? `${this.originOf(masterUrl, this.megaplayBase)}${nextLine}`
                    : `${dirUrl}/${nextLine}`
            }
            sources.push({ url: absolute, type: "m3u8", quality: qualityLabel, subtitles })
        }

        if (sources.length > 0) {
            sources.unshift({ url: masterUrl, type: "m3u8", quality: "Auto", subtitles })
        }
        return sources
    }

    private applyQualityPreference(sources: VideoSource[]): VideoSource[] {
        const raw    = this.preferredQuality
        const target = raw && raw.indexOf("{{") === -1 ? raw : "Auto"
        if (target === "Auto") return sources

        const matched = sources.find((s) => s.quality === target)
        if (!matched) return sources
        return [matched, ...sources.filter((s) => s.quality !== target)]
    }

    private async isPlayable(server: EpisodeServer): Promise<boolean> {
        const src = server.videoSources[0]
        if (!src?.url) return false

        const cacheKey = `anikoto:play:${src.url}`
        const cached   = this.readCache<boolean>(cacheKey, this.playCacheTtl)
        if (cached !== undefined) return cached

        try {
            const res    = await fetch(src.url, { headers: server.headers, timeout: 10 })
            const result = res.ok && (src.type !== "m3u8" || res.text().indexOf("#EXTM3U") !== -1)
            this.writeCache(cacheKey, result)
            return result
        } catch (_e) {
            this.writeCache(cacheKey, false)
            return false
        }
    }

    // ─── ID encoding ──────────────────────────────────────────────────────────

    private encodeId(base: string, audio: string, anilistId: number): string {
        const a = `${base}$${audio}`
        return anilistId > 0 ? `${a}$al${anilistId}` : a
    }

    private decodeId(id: string): { base: string; audio: string; anilistId: number } {
        const parts = id.split("$")
        const out   = { base: parts[0] || "", audio: "sub", anilistId: 0 }

        for (let i = 1; i < parts.length; i++) {
            const p = parts[i]
            if (p === "sub" || p === "dub") { out.audio = p; continue }
            if (p.indexOf("al") === 0) {
                const n = parseInt(p.slice(2), 10)
                if (!isNaN(n)) out.anilistId = n
            }
        }
        return out
    }

    // ─── Cache ────────────────────────────────────────────────────────────────

    private now(): number { try { return Date.now() } catch (_e) { return 0 } }

    private readCache<T>(key: string, ttl?: number): T | undefined {
        const entry = $store.get<{ at: number; data: T }>(key)
        const t     = this.now()
        const max   = ttl ?? this.cacheTtl
        if (entry && t > 0 && entry.at > 0 && t - entry.at < max) return entry.data
        return undefined
    }

    private writeCache<T>(key: string, data: T): void {
        const t = this.now()
        if (t > 0) $store.set(key, { at: t, data })
    }

    // ─── URL utilities ────────────────────────────────────────────────────────

    private watchUrl(href: string): string {
        let u = this.absoluteUrl(href)
        const q = u.indexOf("?"); if (q !== -1) u = u.slice(0, q)
        const h = u.indexOf("#"); if (h !== -1) u = u.slice(0, h)
        return u.replace(/\/ep-[^/]+\/?$/i, "").replace(/\/+$/, "")
    }

    private absoluteUrl(u: string): string {
        if (!u) return u
        if (u.indexOf("http://") === 0 || u.indexOf("https://") === 0) return u
        if (u.indexOf("//") === 0) return `https:${u}`
        if (u.indexOf("/") === 0) return `${this.base()}${u}`
        return `${this.base()}/${u}`
    }

    private originOf(u: string, fallback: string): string {
        const m = u.match(/^(https?:\/\/[^/]+)/i)
        return m ? m[1] : fallback
    }
}
