// ─── Types ────────────────────────────────────────────────────────────────────

type Track = { file: string; label?: string; kind?: string; default?: boolean }
type WarmItem = { episode: number; lang: string; src: string }
type Ctx = { anilistId: number; episode: number }
type SourceResult = { origin: string; file?: string; tracks?: Track[] }

// ─────────────────────────────────────────────────────────────────────────────

class Provider {
    private baseUrl = "{{baseUrl}}"
    private mirrors = [
        "https://anikototv.to",
        "https://anikoto.cz",
        "https://anikoto.me",
        "https://anikoto.net",
        "https://anikototv.se",
    ]
    private cacheTtl        = 900_000   // 15 min
    private serverCacheTtl  = 300_000   // 5 min
    private playCacheTtl    = 120_000   // 2 min  — playability probe results
    private subEndpoint     = "https://sub.ryuo.to"

    // ─── Mirror resolution ────────────────────────────────────────────────────

    private async resolveBase(): Promise<string> {
        const all = [this.baseUrl, ...this.mirrors]
            .map((u) => u.replace(/\/+$/, ""))
            .filter((u, i, arr) => arr.indexOf(u) === i)

        if (all.length === 1) return all[0]

        // Re-validate cached mirror; evict if dead
        const cached = $store.get<string>("anikoto:base")
        if (cached && all.includes(cached)) {
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

    // ─── Headers ──────────────────────────────────────────────────────────────

    private pageHeaders(): Record<string, string> {
        return { Referer: `${this.baseUrl}/` }
    }

    private ajaxHeaders(): Record<string, string> {
        return { Referer: `${this.baseUrl}/`, "X-Requested-With": "XMLHttpRequest" }
    }

    // ─── Fetch helpers ────────────────────────────────────────────────────────

    private async fetchRetry(url: string, opts?: FetchOptions, tries = 2): Promise<FetchResponse> {
        let lastErr: unknown
        for (let i = 0; i < tries; i++) {
            try {
                const res = await fetch(url, opts)
                if (res.ok || res.status < 500 || i === tries - 1) return res
            } catch (e) {
                lastErr = e
                if (i === tries - 1) throw e
            }
        }
        throw lastErr
    }

    private firstAttr($: DocSelectionFunction, selectors: string[], attr: string): string {
        for (const sel of selectors) {
            const v = $(sel).first().attr(attr)
            if (v) return v
        }
        return ""
    }

    // ─── Settings ─────────────────────────────────────────────────────────────

    getSettings(): Settings {
        return {
            episodeServers: ["Auto", "HD-1", "Vidstream-2", "VidCloud-1", "HS: HD-1", "HS: Vidstream-2", "HS: VidCloud-1"],
            supportsDub: true,
        }
    }

    // ─── Search ───────────────────────────────────────────────────────────────

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        this.baseUrl = await this.resolveBase()
        const audio   = opts.dub ? "dub" : "sub"
        const queries = this.searchQueries(opts)
        const results: SearchResult[]       = []
        const seen: Record<string, boolean> = {}
        let anyOk = false

        for (const q of queries) {
            try {
                const res = await fetch(`${this.baseUrl}/filter?keyword=${encodeURIComponent(q)}`, { headers: this.pageHeaders() })
                if (!res.ok) continue
                anyOk = true
                this.parseSearchInto(LoadDoc(res.text()), audio, opts.dub, opts.media.id, seen, results)
            } catch (_e) {}
        }

        if (!anyOk) throw new Error(`[anikoto] search failed for "${queries[0]}" — all mirrors unreachable`)
        return results
    }

    private searchQueries(opts: SearchOptions): string[] {
        return [opts.query, opts.media.romajiTitle, opts.media.englishTitle]
            .map((t) => (t || "").trim())
            .filter((q, i, arr) => q.length > 0 && arr.indexOf(q) === i)
    }

    private parseSearchInto($: DocSelectionFunction, audio: string, dub: boolean, anilistId: number, seen: Record<string, boolean>, results: SearchResult[]): void {
        $("div.item").each((_i, card) => {
            const titleLink = card.find("a.name.d-title").first()
            if (titleLink.length() === 0) return

            const href = titleLink.attr("href") || card.find(".ani.poster.tip a").first().attr("href")
            if (!href) return
            const seriesUrl = this.seriesUrl(href)
            if (seen[seriesUrl]) return

            const title = (titleLink.text() || titleLink.attr("data-jp") || card.find("img").first().attr("alt") || "").trim()
            if (!title) return

            const hasSub = card.find(".ep-status.sub").length() > 0
            const hasDub = card.find(".ep-status.dub").length() > 0
            if (dub && !hasDub) return

            seen[seriesUrl] = true
            const subOrDub: SubOrDub = hasSub && hasDub ? "both" : hasDub ? "dub" : "sub"
            results.push({ id: this.withMeta(seriesUrl, audio, anilistId), title, url: seriesUrl, subOrDub })
        })
    }

    // ─── Episodes ─────────────────────────────────────────────────────────────

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        this.baseUrl = await this.resolveBase()
        const parsed    = this.splitMeta(id)
        const { audio, anilistId } = parsed
        const seriesUrl = this.seriesUrl(this.absoluteUrl(parsed.base))

        const cacheKey = `anikoto:eps:${seriesUrl}:${audio}:${anilistId}`
        const cached   = this.readCache<EpisodeDetails[]>(cacheKey)
        if (cached && cached.length > 0) return cached

        const page = await this.fetchRetry(seriesUrl, { headers: this.pageHeaders() })
        if (!page.ok) throw new Error(`[anikoto] findEpisodes: HTTP ${page.status} for ${seriesUrl}`)

        const pageHtml = page.text()
        const seriesId = this.extractSeriesId(LoadDoc(pageHtml), pageHtml)
        if (!seriesId) throw new Error(`[anikoto] findEpisodes: could not find data-id in ${seriesUrl}`)

        const listRes = await this.fetchRetry(`${this.baseUrl}/ajax/episode/list/${seriesId}`, { headers: this.ajaxHeaders() })
        if (!listRes.ok) throw new Error(`[anikoto] episode list: HTTP ${listRes.status} for series ${seriesId}`)

        const listJson = listRes.json<{ status: number; result: string }>()
        if (!listJson?.result) throw new Error(`[anikoto] episode list: empty response for series ${seriesId}`)

        const episodes = this.parseEpisodeList(LoadDoc(listJson.result), seriesUrl, audio, anilistId)
        if (episodes.length === 0) throw new Error(`[anikoto] no episodes found for series ${seriesId}`)

        episodes.sort((a, b) => a.number - b.number)
        this.writeCache(cacheKey, episodes)
        if (anilistId > 0) this.writeCache(`anikoto:eplist:${anilistId}`, episodes.map((e) => ({ id: e.id, number: e.number })))
        return episodes
    }

    private extractSeriesId($: DocSelectionFunction, html: string): string {
        const fromDoc = this.firstAttr($, ["#watch-main", "[id*='watch'][data-id]", "main [data-id]"], "data-id")
        if (fromDoc) return fromDoc
        const m = html.match(/data-id="(\d+)"/)
        return m ? m[1] : ""
    }

    private parseEpisodeList($: DocSelectionFunction, seriesUrl: string, audio: string, anilistId: number): EpisodeDetails[] {
        const episodes: EpisodeDetails[]    = []
        const seen: Record<string, boolean> = {}

        let epNodes = $("ul.ep-range li > a")
        if (epNodes.length() === 0) epNodes = $(".ep-range a")
        if (epNodes.length() === 0) epNodes = $("a[data-ids]")

        epNodes.each((i, a) => {
            const epId   = a.attr("data-id") || ""
            const dataIds = a.attr("data-ids")
            if (!dataIds) return
            const dedupeKey = epId || dataIds
            if (seen[dedupeKey]) return
            seen[dedupeKey] = true

            const num    = parseInt(a.attr("data-num") || "", 10)
            const number = isNaN(num) ? i + 1 : num
            const slug   = a.attr("data-slug") || String(number)
            const title  = a.find("span.d-title").first().text().trim() || undefined

            episodes.push({ id: this.withMeta(dataIds, audio, anilistId), number, url: `${seriesUrl}/ep-${slug}`, title })
        })

        return episodes
    }

    // ─── Servers ──────────────────────────────────────────────────────────────

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        this.baseUrl = await this.resolveBase()
        const parsed = this.splitMeta(episode.id)
        const ctx    = { anilistId: parsed.anilistId, episode: episode.number }

        const isAuto = !server || server === "Auto" || server === "default"
        if (isAuto) return this.resolveAutoServer(parsed.base, parsed.audio, ctx, server === "Auto" ? "Auto" : "")

        const target = this.parseServerLabel(server, parsed.audio)
        if (!target.ok) throw new Error(`[anikoto] server "${server}" is not available for ${parsed.audio} audio`)

        const $ = await this.serverListDoc(parsed.base)
        const picked = this.collectServers($, [target.group]).find((c) => c.name === target.name)
        if (!picked) throw new Error(`[anikoto] server "${server}" not found for this episode`)

        const result = await this.resolveServer(picked.linkId, target.label, ctx)
        this.firePrefetch(ctx)
        return result
    }

    private async resolveAutoServer(dataIds: string, audio: string, ctx: Ctx, label: string): Promise<EpisodeServer> {
        const $ = await this.serverListDoc(dataIds)
        const groups     = audio === "dub" ? ["dub"] : ["sub", "hsub"]
        const candidates = this.collectServers($, groups)
        if (candidates.length === 0) throw new Error("[anikoto] no servers available for this episode")

        // Resolve + check playability all in parallel
        const settled  = await Promise.allSettled<EpisodeServer>(candidates.map((c) => this.resolveServer(c.linkId, c.name, ctx)))
        const resolved = settled.filter((r): r is PromiseFulfilledResult<EpisodeServer> => r.status === "fulfilled").map((r) => r.value)
        if (resolved.length === 0) throw new Error("[anikoto] no playable server found for this episode")

        const playable = await Promise.allSettled(resolved.map((s) => this.isPlayable(s)))
        const winIdx   = playable.findIndex((r) => r.status === "fulfilled" && r.value)
        const winner   = winIdx !== -1 ? resolved[winIdx] : resolved[0]

        if (label) winner.server = label
        this.firePrefetch(ctx)
        return winner
    }

    private parseServerLabel(server: string, audio: string): { group: string; name: string; label: string; ok: boolean } {
        const hs = server.match(/^hs:\s*/i)
        if (hs) return { group: "hsub", name: server.slice(hs[0].length), label: server, ok: audio !== "dub" }
        return { group: audio === "dub" ? "dub" : "sub", name: server, label: server, ok: true }
    }

    private async serverListDoc(dataIds: string): Promise<DocSelectionFunction> {
        const cacheKey = `anikoto:slist:${dataIds}`
        let html = this.readCache<string>(cacheKey, this.serverCacheTtl)
        if (!html) {
            const res = await fetch(`${this.baseUrl}/ajax/server/list?servers=${encodeURIComponent(dataIds)}`, { headers: this.ajaxHeaders() })
            if (!res.ok) throw new Error(`[anikoto] server list: HTTP ${res.status}`)
            html = res.json<{ status: number; result: string }>().result || ""
            if (html) this.writeCache(cacheKey, html)
        }
        return LoadDoc(html)
    }

    private collectServers($: DocSelectionFunction, groups: string[]): { name: string; linkId: string }[] {
        const out: { name: string; linkId: string }[] = []
        const seen: Record<string, boolean> = {}
        for (const t of groups) {
            $(`.servers .type[data-type="${t}"] li[data-link-id]`).each((_i, el) => {
                const linkId = el.attr("data-link-id")
                const name   = el.text().trim()
                if (!linkId || !name || seen[linkId]) return
                seen[linkId] = true
                out.push({ name, linkId })
            })
        }
        return out
    }

    // ─── Source resolution ────────────────────────────────────────────────────

    private async resolveServer(linkId: string, serverName: string, ctx: Ctx): Promise<EpisodeServer> {
        const got = await this.fetchSources(linkId)
        if (!got?.file) throw new Error(`[anikoto] could not resolve stream URL for linkId ${linkId}`)
        const subtitles = await this.buildSubtitles(got.tracks, ctx)
        this.fireWarmEpisode(ctx, got.tracks)
        return {
            server:       serverName,
            headers:      { Referer: `${got.origin}/`, Origin: got.origin },
            videoSources: [{ url: got.file, type: "m3u8", quality: "default", subtitles }],
        }
    }

    private async isPlayable(server: EpisodeServer): Promise<boolean> {
        const src = server.videoSources[0]
        if (!src?.url) return false
        const cacheKey = `anikoto:play:${src.url}`
        const cached   = this.readCache<boolean>(cacheKey, this.playCacheTtl)
        if (cached !== undefined) return cached
        try {
            const res    = await fetch(src.url, { headers: server.headers, timeout: 10 })
            const result = res.ok && res.text().indexOf("#EXTM3U") !== -1
            this.writeCache(cacheKey, result)
            return result
        } catch (_e) {
            this.writeCache(cacheKey, false)
            return false
        }
    }

    private async fetchSources(linkId: string): Promise<SourceResult | undefined> {
        const psRes = await this.fetchRetry(`${this.baseUrl}/ajax/server?get=${encodeURIComponent(linkId)}`, { headers: this.ajaxHeaders() })
        if (!psRes.ok) return undefined

        const embedUrl = psRes.json<{ status: number; result: { url: string } }>()?.result?.url
        if (!embedUrl) return undefined

        const origin   = this.originOf(embedUrl)
        const embedRes = await this.fetchRetry(embedUrl, { headers: { Referer: `${this.baseUrl}/` }, timeout: 12 })
        if (!embedRes.ok) return undefined

        const ehtml = embedRes.text()
        let dataId  = this.firstAttr(LoadDoc(ehtml), ["#megaplay-player", "[id*='player'][data-id]"], "data-id")
        if (!dataId) { const m = ehtml.match(/data-id="([^"]+)"/); if (m) dataId = m[1] }
        if (!dataId) return undefined

        const srcRes = await this.fetchRetry(
            `${origin}/stream/getSources?id=${encodeURIComponent(dataId)}`,
            { headers: { Referer: embedUrl, "X-Requested-With": "XMLHttpRequest" }, timeout: 12 }
        )
        if (!srcRes.ok) return undefined

        const data = srcRes.json<{ sources: { file: string } | { file: string }[]; tracks?: Track[] }>()
        const file = Array.isArray(data.sources) ? data.sources[0]?.file : data.sources.file
        return { origin, file, tracks: data.tracks }
    }

    // ─── Prefetch / warm ──────────────────────────────────────────────────────

    private firePrefetch(ctx: Ctx): void { void this.prefetchSeries(ctx).catch(() => {}) }
    private fireWarmEpisode(ctx: Ctx, tracks: Track[] | undefined): void { void this.warmEpisode(ctx, tracks).catch(() => {}) }

    private async warmEpisode(ctx: Ctx, tracks: Track[] | undefined): Promise<void> {
        if (ctx.anilistId <= 0 || !tracks?.length) return
        const valid = this.captionTracks(tracks)
        if (valid.length === 0) return
        const codes = await this.langCodes(valid.map((t) => t.label || "English"))
        const items = this.dedupeTrackItems(valid, codes, ctx.episode)
        if (items.length > 0) await this.postWarm(ctx.anilistId, items)
    }

    private async prefetchSeries(ctx: Ctx): Promise<void> {
        if (ctx.anilistId <= 0) return
        const eplist = this.readCache<{ id: string; number: number }[]>(`anikoto:eplist:${ctx.anilistId}`)
        if (!eplist?.length) return

        const cached = await this.fetchCachedEpisodes(ctx.anilistId)
        const cap    = eplist.length > 50 ? 8 : 20

        const pending = eplist.filter((ep) =>
            ep.number !== ctx.episode &&
            !cached[ep.number] &&
            !this.readCache<boolean>(`anikoto:ew:${ctx.anilistId}:${ep.number}`, 21_600_000)
        ).slice(0, cap)

        if (pending.length === 0) return

        // Mark in-flight immediately to prevent duplicate work
        for (const ep of pending) this.writeCache(`anikoto:ew:${ctx.anilistId}:${ep.number}`, true)

        // Resolve tracks for all pending episodes concurrently
        const trackResults = await Promise.allSettled(
            pending.map((ep) => { const p = this.splitMeta(ep.id); return this.resolveTracksFor(p.base, p.audio) })
        )

        const items: WarmItem[] = []
        for (let i = 0; i < pending.length; i++) {
            const r = trackResults[i]
            if (r.status !== "fulfilled" || !r.value?.length) continue
            const valid = this.captionTracks(r.value)
            const codes = await this.langCodes(valid.map((t) => t.label || "English"))
            items.push(...this.dedupeTrackItems(valid, codes, pending[i].number))
        }

        if (items.length > 0) await this.postWarm(ctx.anilistId, items)
    }

    private async fetchCachedEpisodes(anilistId: number): Promise<Record<number, boolean>> {
        try {
            const res = await fetch(`${this.subEndpoint}/cached/${anilistId}`)
            if (res.ok) {
                const data = res.json<{ episodes: number[] }>()
                if (data?.episodes) return Object.fromEntries(data.episodes.map((e) => [e, true]))
            }
        } catch (_e) {}
        return {}
    }

    private async postWarm(anilistId: number, items: WarmItem[]): Promise<void> {
        await fetch(`${this.subEndpoint}/warm`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ anilist: anilistId, items }),
        })
    }

    // ─── Track helpers ────────────────────────────────────────────────────────

    private captionTracks(tracks: Track[]): Track[] {
        return tracks.filter((t) => t?.file && (!t.kind || t.kind === "captions" || t.kind === "subtitles"))
    }

    private dedupeTrackItems(valid: Track[], codes: string[], episode: number): WarmItem[] {
        const seen: Record<string, boolean> = {}
        return valid.reduce<WarmItem[]>((acc, t, i) => {
            const lang = codes[i]
            if (!seen[lang]) { seen[lang] = true; acc.push({ episode, lang, src: t.file }) }
            return acc
        }, [])
    }

    private async resolveTracksFor(dataIds: string, audio: string): Promise<Track[] | undefined> {
        const $          = await this.serverListDoc(dataIds)
        const groups     = audio === "dub" ? ["dub"] : ["sub", "hsub"]
        const candidates = this.collectServers($, groups)
        // Try all candidates in parallel; return first with tracks
        const results = await Promise.allSettled(candidates.map((c) => this.fetchSources(c.linkId)))
        for (const r of results) {
            if (r.status === "fulfilled" && r.value?.tracks?.length) return r.value.tracks
        }
        return undefined
    }

    // ─── Subtitles ────────────────────────────────────────────────────────────

    private async buildSubtitles(tracks: Track[] | undefined, ctx: Ctx): Promise<VideoSubtitle[]> {
        if (!tracks?.length) return []
        const anime = ctx.anilistId > 0 ? String(ctx.anilistId) : "unknown"
        const ep    = ctx.episode > 0   ? String(ctx.episode)   : "0"
        const valid = this.captionTracks(tracks)
        const codes = await this.langCodes(valid.map((t) => t.label || "English"))

        const collected: VideoSubtitle[]        = []
        const seenLang: Record<string, boolean> = {}
        let englishIdx = -1
        let defaultIdx = -1

        for (let i = 0; i < valid.length; i++) {
            const t    = valid[i]
            const lang = codes[i]
            if (seenLang[lang]) continue
            seenLang[lang] = true
            const idx = collected.length
            collected.push({
                id:        `${lang}-${idx}`,
                url:       `${this.subEndpoint}/s/${anime}/${ep}/${lang}.vtt?src=${encodeURIComponent(t.file)}`,
                language:  t.label || "English",
                isDefault: false,
            })
            if (englishIdx === -1 && lang === "en") englishIdx = idx
            if (defaultIdx === -1 && t.default === true) defaultIdx = idx
        }

        if (collected.length === 0) return collected
        const pick = englishIdx !== -1 ? englishIdx : defaultIdx !== -1 ? defaultIdx : 0
        collected[pick].isDefault = true
        return [collected[pick], ...collected.filter((_, i) => i !== pick)]
    }

    // ─── Language codes ───────────────────────────────────────────────────────

    private async langCodes(labels: string[]): Promise<string[]> {
        const out: string[]                             = new Array(labels.length)
        const missing: { idx: number; label: string }[] = []

        for (let i = 0; i < labels.length; i++) {
            const c = this.readCache<string>(`anikoto:lang:${labels[i]}`, 604_800_000)
            if (c) out[i] = c
            else missing.push({ idx: i, label: labels[i] })
        }
        if (missing.length === 0) return out

        let codes: string[] = []
        try {
            const res = await fetch(`${this.subEndpoint}/lang`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ labels: missing.map((m) => m.label) }),
            })
            if (res.ok) codes = res.json<{ codes: string[] }>().codes ?? []
        } catch (_e) {}

        for (let k = 0; k < missing.length; k++) {
            const code = codes[k] || this.fallbackCode(missing[k].label)
            out[missing[k].idx] = code
            this.writeCache(`anikoto:lang:${missing[k].label}`, code)
        }
        return out
    }

    private fallbackCode(label: string): string {
        return (label || "english").toLowerCase().replace(/[^a-z]/g, "").slice(0, 2) || "en"
    }

    // ─── ID encoding ──────────────────────────────────────────────────────────

    private withMeta(base: string, audio: string, anilistId: number): string {
        const a = `${base}$${audio}`
        return anilistId > 0 ? `${a}$al${anilistId}` : a
    }

    private splitMeta(id: string): { base: string; audio: string; anilistId: number } {
        let rest      = id
        let anilistId = 0
        const alMatch = rest.match(/\$al(\d+)$/)
        if (alMatch) { anilistId = parseInt(alMatch[1], 10); rest = rest.slice(0, rest.length - alMatch[0].length) }
        const i = rest.lastIndexOf("$")
        if (i !== -1) {
            const a = rest.slice(i + 1)
            if (a === "sub" || a === "dub") return { base: rest.slice(0, i), audio: a, anilistId }
        }
        return { base: rest, audio: "sub", anilistId }
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

    private seriesUrl(href: string): string {
        let u = this.absoluteUrl(href)
        const q = u.indexOf("?"); if (q !== -1) u = u.slice(0, q)
        const h = u.indexOf("#"); if (h !== -1) u = u.slice(0, h)
        return u.replace(/\/ep-[^/]+\/?$/i, "")
    }

    private absoluteUrl(u: string): string {
        if (!u) return u
        if (u.startsWith("http://") || u.startsWith("https://")) return u
        if (u.startsWith("//")) return `https:${u}`
        if (u.startsWith("/")) return `${this.baseUrl}${u}`
        return `${this.baseUrl}/${u}`
    }

    private originOf(u: string): string {
        const m = u.match(/^(https?:\/\/[^/]+)/i)
        return m ? m[1] : this.baseUrl
    }
}