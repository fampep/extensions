// ─── Types ────────────────────────────────────────────────────────────────────

type GqlTrack   = { label?: string; kind?: string; default?: boolean; local?: string; trackPath?: string }
type GqlSource  = { sou_id?: string; src_type?: string; src_server?: number; src_name?: string; souPath?: string; track?: GqlTrack[] }
type GqlNode<T> = { id?: string; data?: T }
type GqlEpisode = {
    ani_id?: string
    ep_id?: string
    ep_index?: number
    ep_title?: string
    epPath?: string
    sourcesNode_list?: GqlNode<GqlSource>[]
}
type GqlAnime = {
    ani_id?: string
    al_id?: string | number
    ani_id_mal?: string | number
    info_title?: string
    aniPath?: string
    info_meta_year?: string
}

// ─────────────────────────────────────────────────────────────────────────────
//
//  XAnime (xanime.me) — HLS straight out of the site's GraphQL API.
//  Ported from the Anikoto API's `providers/xanime.rs`.
//
//  Everything runs against a single endpoint, POST {base}/z2/ :
//    get_q27  search        → items[].data { ani_id, al_id, info_title, aniPath }
//    get_q01  episode list  → paging{total} + items[].data { ep_id, ep_index, epPath,
//                                                            sourcesNode_list[].data.src_type }
//    get_q07  episode       → sourcesNode_list[].data { souPath, src_name, track[] }
//
//  `souPath` is already a playable master.m3u8 and `track[].trackPath` a WebVTT
//  file, so there is no embed page and no obfuscated player to unwrap. Search
//  results carry `al_id`, which is the AniList id — exact matches are hoisted
//  to the top instead of being guessed from the title.
//
//  Requests still go through a cookie jar (Set-Cookie is merged into $store and
//  replayed) so any session the CDN hands out survives between calls.
//
// ─────────────────────────────────────────────────────────────────────────────

class Provider {
    private baseUrl          = "{{baseUrl}}"
    private preferredQuality = "{{preferred_quality}}"
    private fallbackBase     = "https://xanime.me"

    private pageSize   = 100
    private maxPages   = 20         // 2000 episodes — enough for One Piece and friends
    private cacheTtl   = 900_000    // 15 min — search hits, episode lists
    private epCacheTtl = 300_000    // 5 min  — per-episode source data
    private playCacheTtl = 120_000  // 2 min  — playability probes
    private jarTtl     = 3_600_000  // 60 min — cookie jar lifetime

    private userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

    // ─── GraphQL documents ────────────────────────────────────────────────────

    private searchQuery = `
        query get_q27($select: SearchAnime_Select) {
          get_q27(select: $select) {
            items {
              id
              data { ani_id al_id ani_id_mal info_title aniPath info_meta_year }
            }
          }
        }
    `

    private episodeListQuery = `
        query get_q01($select: AnimesEpisodesList_Select) {
          get_q01(select: $select) {
            paging { total page size }
            items {
              id
              data {
                ani_id ep_id ep_index ep_title epPath
                sourcesNode_list { id data { sou_id src_type src_server } }
              }
            }
          }
        }
    `

    private episodeQuery = `
        query get_q07($select: Episodes_Select) {
          get_q07(select: $select) {
            id
            data {
              ani_id ep_id ep_index ep_title epPath
              sourcesNode_list {
                id
                data {
                  sou_id src_type src_server src_name souPath
                  track { label kind default local trackPath }
                }
              }
            }
          }
        }
    `

    // ─── Base URL ─────────────────────────────────────────────────────────────

    private base(): string {
        const raw = this.baseUrl
        const usable = raw && raw.indexOf("{{") === -1 ? raw : this.fallbackBase
        return usable.replace(/\/+$/, "")
    }

    private gqlEndpoint(): string { return `${this.base()}/z2/` }

    private absoluteUrl(path: string): string {
        if (!path) return path
        if (path.indexOf("http") === 0) return path
        if (path.indexOf("/") === 0) return `${this.base()}${path}`
        return `${this.base()}/${path}`
    }

    // ─── Cookie jar ───────────────────────────────────────────────────────────

    private jarKey(): string { return `xanime:jar:${this.base()}` }

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

    // ─── GraphQL transport ────────────────────────────────────────────────────

    private async gql<T>(query: string, variables: any, referer: string, tries = 2): Promise<T> {
        const headers: Record<string, string> = {
            "User-Agent":   this.userAgent,
            "Accept":       "application/json",
            "Content-Type": "application/json",
            "Origin":       this.base(),
            "Referer":      referer,
        }
        const cookie = this.cookieHeader()
        if (cookie) headers["Cookie"] = cookie

        const body = JSON.stringify({ query, variables })
        let lastErr: unknown

        for (let i = 0; i < tries; i++) {
            try {
                const res = await fetch(this.gqlEndpoint(), { method: "POST", headers, body, timeout: 12 })
                this.absorbCookies(res)

                if (!res.ok && res.status >= 500 && i < tries - 1) continue
                if (!res.ok) throw new Error(`[xanime] GraphQL HTTP ${res.status}`)

                const payload = res.json<{ data?: T; errors?: { message?: string }[] }>()
                if (payload?.errors && payload.errors.length > 0) {
                    throw new Error(`[xanime] GraphQL: ${payload.errors[0]?.message || "query rejected"}`)
                }
                if (!payload || payload.data === undefined || payload.data === null) {
                    throw new Error("[xanime] GraphQL returned no data")
                }
                return payload.data
            } catch (e) {
                lastErr = e
                if (i === tries - 1) throw e
            }
        }
        throw lastErr
    }

    // ─── Settings ─────────────────────────────────────────────────────────────

    getSettings(): Settings {
        return {
            episodeServers: ["Auto", "Server 1", "Server 2", "Server 3"],
            supportsDub: true,
        }
    }

    // ─── Search ───────────────────────────────────────────────────────────────

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const audio   = opts.dub ? "dub" : "sub"
        const queries = this.searchQueries(opts)
        const exact: SearchResult[] = []
        const rest: SearchResult[]  = []
        const seen: Record<string, boolean> = {}
        let anyOk = false

        for (const q of queries) {
            let items: GqlNode<GqlAnime>[] = []
            try {
                const data = await this.gql<{ get_q27?: { items?: GqlNode<GqlAnime>[] } }>(
                    this.searchQuery,
                    { select: { word: q, size: 6, page: 1, sortby: "field_score" } },
                    `${this.base()}/search?word=${encodeURIComponent(q)}`,
                )
                anyOk = true
                items = data?.get_q27?.items || []
            } catch (_e) { continue }

            for (const item of items) {
                const d      = item.data || {}
                const siteId = (d.ani_id || item.id || "").toString().trim()
                if (!siteId || seen[siteId]) continue
                seen[siteId] = true

                const year   = (d.info_meta_year || "").toString().trim()
                const title  = (d.info_title || "").trim() || siteId
                const result: SearchResult = {
                    id:       this.encodeId(siteId, audio, opts.media.id),
                    title:    year ? `${title} (${year})` : title,
                    url:      d.aniPath ? this.absoluteUrl(d.aniPath) : `${this.base()}/title/${siteId}`,
                    // Per-episode sub/dub flags come from the episode list, which
                    // findEpisodes reads and filters on.
                    subOrDub: "both",
                }

                // The site stores the AniList id itself — an exact hit beats any title score.
                const alId = this.toInt(d.al_id)
                if (alId > 0 && alId === opts.media.id) exact.push(result)
                else rest.push(result)
            }
        }

        if (!anyOk) throw new Error(`[xanime] search failed for "${queries[0]}" — API unreachable`)
        return [...exact, ...rest]
    }

    private searchQueries(opts: SearchOptions): string[] {
        return [opts.query, opts.media.romajiTitle, opts.media.englishTitle, ...(opts.media.synonyms || [])]
            .map((t) => (t || "").trim())
            .filter((q, i, arr) => q.length > 0 && arr.indexOf(q) === i)
            .slice(0, 4)
    }

    // ─── Episodes ─────────────────────────────────────────────────────────────

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const meta   = this.decodeId(id)
        const siteId = meta.base
        if (!siteId) throw new Error(`[xanime] findEpisodes: no site id in "${id}"`)

        const cacheKey = `xanime:eps:${siteId}:${meta.audio}:${meta.anilistId}`
        const cached   = this.readCache<EpisodeDetails[]>(cacheKey)
        if (cached && cached.length > 0) return cached

        const referer = `${this.base()}/title/${siteId}`
        const first   = await this.episodePage(siteId, 1, referer)
        const rows    = [...(first.items || [])]

        const total    = this.toInt(first.paging?.total)
        const maxPage  = Math.min(Math.ceil(total / this.pageSize) || 1, this.maxPages)
        if (maxPage > 1) {
            const pages: number[] = []
            for (let p = 2; p <= maxPage; p++) pages.push(p)
            const settled = await Promise.allSettled(pages.map((p) => this.episodePage(siteId, p, referer)))
            for (const r of settled) {
                if (r.status === "fulfilled") rows.push(...(r.value.items || []))
            }
        }
        if (rows.length === 0) throw new Error(`[xanime] no episodes for title ${siteId}`)

        const wantDub = meta.audio === "dub"
        const episodes: EpisodeDetails[]      = []
        const seen: Record<number, boolean>   = {}

        for (const node of rows) {
            const d      = node.data || {}
            const number = this.toInt(d.ep_index)
            const epId   = (d.ep_id || node.id || "").toString().trim()
            if (number < 1 || !epId || seen[number]) continue
            if (!this.hasAudio(d.sourcesNode_list, wantDub)) continue
            seen[number] = true

            episodes.push({
                id:     this.encodeId(`${epId}~${d.epPath || ""}`, meta.audio, meta.anilistId),
                number,
                url:    d.epPath ? this.absoluteUrl(d.epPath) : referer,
                title:  (d.ep_title || "").trim() || `Episode ${number}`,
            })
        }

        if (episodes.length === 0) {
            throw new Error(`[xanime] no ${meta.audio} episodes for title ${siteId}`)
        }

        episodes.sort((a, b) => a.number - b.number)
        this.writeCache(cacheKey, episodes)
        return episodes
    }

    private async episodePage(siteId: string, page: number, referer: string): Promise<{ paging?: { total?: number }; items?: GqlNode<GqlEpisode>[] }> {
        const data = await this.gql<{ get_q01?: { paging?: { total?: number }; items?: GqlNode<GqlEpisode>[] } }>(
            this.episodeListQuery,
            { select: { ani_id: siteId, size: this.pageSize, page } },
            referer,
        )
        return data?.get_q01 || {}
    }

    /** The list query already reports which audio tracks an episode carries. */
    private hasAudio(sources: GqlNode<GqlSource>[] | undefined, wantDub: boolean): boolean {
        if (!sources || sources.length === 0) return !wantDub
        const wanted = wantDub ? "dub" : "sub"
        let sawTyped = false
        for (const s of sources) {
            const t = (s.data?.src_type || "").toLowerCase()
            if (t) sawTyped = true
            if (t === wanted) return true
        }
        // Untyped source lists are treated as sub-only, never as a dub promise.
        return !sawTyped && !wantDub
    }

    // ─── Servers ──────────────────────────────────────────────────────────────

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const meta  = this.decodeId(episode.id)
        const tilde = meta.base.indexOf("~")
        const epId  = tilde === -1 ? meta.base : meta.base.slice(0, tilde)
        const epPath = tilde === -1 ? "" : meta.base.slice(tilde + 1)
        if (!epId) throw new Error(`[xanime] malformed episode id "${episode.id}"`)

        const sources = await this.episodeSources(epId, epPath)
        const wanted  = meta.audio === "dub" ? "dub" : "sub"
        const matching = sources.filter((s) => (s.src_type || "").toLowerCase() === wanted)
        if (matching.length === 0) throw new Error(`[xanime] no ${wanted} source for episode ${episode.number}`)

        const isAuto = !server || server === "Auto" || server === "default"

        if (!isAuto) {
            const picked = matching.find((s) => this.serverName(s).toLowerCase() === server.toLowerCase())
            if (!picked) throw new Error(`[xanime] server "${server}" not available for episode ${episode.number}`)
            return this.buildServer(picked, epPath)
        }

        const settled  = await Promise.allSettled<EpisodeServer>(matching.map((s) => this.buildServer(s, epPath)))
        const resolved = settled
            .filter((r): r is PromiseFulfilledResult<EpisodeServer> => r.status === "fulfilled")
            .map((r) => r.value)
        if (resolved.length === 0) throw new Error(`[xanime] no playable source for episode ${episode.number}`)

        const playable = await Promise.allSettled(resolved.map((s) => this.isPlayable(s)))
        const winIdx   = playable.findIndex((r) => r.status === "fulfilled" && r.value)
        return winIdx !== -1 ? resolved[winIdx] : resolved[0]
    }

    private async episodeSources(epId: string, epPath: string): Promise<GqlSource[]> {
        const cacheKey = `xanime:src:${epId}`
        const cached   = this.readCache<GqlSource[]>(cacheKey, this.epCacheTtl)
        if (cached && cached.length > 0) return cached

        const referer = epPath ? this.absoluteUrl(epPath) : `${this.base()}/title/episode/${epId}`
        const data    = await this.gql<{ get_q07?: GqlNode<GqlEpisode> }>(
            this.episodeQuery,
            { select: { id: epId } },
            referer,
        )

        const nodes = data?.get_q07?.data?.sourcesNode_list || []
        const out: GqlSource[] = []
        for (const node of nodes) {
            const d = node.data
            if (!d || !d.souPath || d.souPath.indexOf("http") !== 0) continue
            if (!d.sou_id && node.id) d.sou_id = node.id
            out.push(d)
        }
        if (out.length === 0) throw new Error(`[xanime] no sources for episode ${epId}`)

        this.writeCache(cacheKey, out)
        return out
    }

    private serverName(source: GqlSource): string {
        const name = (source.src_name || "").toString().trim()
        if (name) return `Server ${name}`
        const idx = this.toInt(source.src_server)
        return `Server ${idx + 1}`
    }

    private async buildServer(source: GqlSource, epPath: string): Promise<EpisodeServer> {
        const file = source.souPath || ""
        if (!file) throw new Error("[xanime] source without souPath")

        // The player asks for the stream from …/{epPath}/{sou_id}; the CDN checks it.
        let referer = this.base()
        if (epPath) {
            const page = this.absoluteUrl(epPath)
            referer = source.sou_id ? `${page}/${source.sou_id}` : page
        }
        const headers = { "User-Agent": this.userAgent, "Referer": referer, "Origin": this.base() }

        const subtitles = this.buildSubtitles(source.track)

        let videoSources: VideoSource[] = []
        try {
            const manifest = await fetch(file, { headers, timeout: 8 })
            if (manifest.ok) videoSources = this.parseM3U8Qualities(manifest.text(), file, subtitles)
        } catch (_e) {}

        if (videoSources.length === 0) {
            videoSources.push({ url: file, type: "m3u8", quality: "default", subtitles })
        }

        return {
            server: this.serverName(source),
            headers,
            videoSources: this.applyQualityPreference(videoSources),
        }
    }

    // ─── Subtitles ────────────────────────────────────────────────────────────

    private buildSubtitles(tracks: GqlTrack[] | undefined): VideoSubtitle[] {
        if (!tracks || tracks.length === 0) return []

        const collected: VideoSubtitle[]         = []
        const seenLabel: Record<string, boolean> = {}
        let englishIdx = -1
        let defaultIdx = -1

        for (const t of tracks) {
            const path = t?.trackPath
            if (!path) continue
            const kind = t.kind || "captions"
            if (kind !== "captions" && kind !== "subtitles") continue

            const label = (t.label || "English").trim()
            const key   = label.toLowerCase()
            if (seenLabel[key]) continue
            seenLabel[key] = true

            const idx = collected.length
            collected.push({
                id:        `${key.replace(/[^a-z0-9]/g, "") || "sub"}-${idx}`,
                url:       this.absoluteUrl(path),
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

    // ─── Manifest / quality ───────────────────────────────────────────────────

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

            // Variant playlists are served as .ico here — still HLS.
            let absolute = nextLine
            if (nextLine.indexOf("http://") !== 0 && nextLine.indexOf("https://") !== 0) {
                absolute = nextLine.indexOf("/") === 0
                    ? `${this.originOf(masterUrl)}${nextLine}`
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

        const cacheKey = `xanime:play:${src.url}`
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

    // ─── Misc ─────────────────────────────────────────────────────────────────

    private toInt(v: any): number {
        if (typeof v === "number") return isNaN(v) ? 0 : Math.floor(v)
        const n = parseInt(String(v ?? ""), 10)
        return isNaN(n) ? 0 : n
    }

    private originOf(u: string): string {
        const m = u.match(/^(https?:\/\/[^/]+)/i)
        return m ? m[1] : this.base()
    }
}
