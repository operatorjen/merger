import 'dotenv/config'
import { DEFAULT_LEXICON, DEFAULT_TEMPLATES, STANCE_LABELS, CONJUNCTIONS, PRONOUNS,
  MODALS, AUX, PREP, POS_KEYS
} from './shared.mjs'
import { PROMPTS } from './prompts.mjs'

const DEFAULT_MIN_TEMPLATES_PER_STANCE = 4
const DEFAULT_MIN_LEXICON_PER_POS = 6
const DEFAULT_BASE_TEMPLATE_RETENTION = 0.5
const DEFAULT_BASE_LEXICON_RETENTION = 0.5
const DEBUG_TEMPLATE_SAMPLE_SIZE = 10
const DEBUG_LEXICON_SAMPLE_SIZE = 10
const RELATIONAL_SCORE_OFFSET = 0.5
const RELATIONAL_SCORE_SCALE = 0.5
const SUPPORTIVE_RELATIONAL_DELTA = {
  trust: 0.05,
  comfort: 0.05,
  alignment: 0.03,
  energy: 0.02
}
const DEFENSIVE_RELATIONAL_DELTA = {
  trust: -0.05,
  comfort: -0.06,
  alignment: -0.04,
  energy: -0.03
}
const NEUTRAL_RELATIONAL_DELTA = {
  trust: 0.01,
  comfort: 0.01,
  alignment: 0,
  energy: 0
}

export class Merger {
  constructor(tasteConfig = {}, relational = null, funnels = null, options = {}) {
    this.tasteConfig = tasteConfig
    this.relational = relational
    this.funnels = funnels || null
    this.cfg = {
      minTemplatesPerStance: options.minTemplatesPerStance || DEFAULT_MIN_TEMPLATES_PER_STANCE,
      minLexiconPerPos: options.minLexiconPerPos || DEFAULT_MIN_LEXICON_PER_POS,
      defaultModel: options.defaultModel,
      baseTemplateRetention: options.baseTemplateRetention ?? DEFAULT_BASE_TEMPLATE_RETENTION,
      bLRetention: options.bLRetention ?? DEFAULT_BASE_LEXICON_RETENTION,
      ...options
    }
    this.configs = this._loadConfigs()
    this.buckets = this._initBuckets()
  }

  applyLexiconSyntaxOverrides({ lexicon, syntax } = {}) {
    if (!lexicon && !syntax) return
    const baseLex = this._getBaseLexicon()
    const baseTemplates = this._getBaseTemplates()
    const mergedLex = this._cloneLexicon(baseLex)
    if (lexicon && typeof lexicon === 'object') {
      const looksFlat = POS_KEYS.some(k => Array.isArray(lexicon[k]))
      const sources = looksFlat ? [lexicon] : Object.values(lexicon).filter(v => v && typeof v === 'object')
      const seenByPos = {}
      for (const k of POS_KEYS) { seenByPos[k] = new Set(mergedLex[k] || []) }
      for (const src of sources) {
        for (const k of POS_KEYS) {
          const arr = Array.isArray(src[k]) ? src[k] : []
          for (const token of arr) {
            if (!token) continue
            if (!seenByPos[k].has(token)) {
              seenByPos[k].add(token)
              mergedLex[k].push(token)
            }
          }
        }
      }
    }
    let mergedTemplates = Array.isArray(baseTemplates) ? [...baseTemplates] : []
    if (syntax && typeof syntax === 'object') {
      const collectFromSyntaxObj = (s, out) => {
        if (!s || typeof s !== 'object') return
        const selfArr = Array.isArray(s.self) ? s.self : []
        const otherArr = Array.isArray(s.otherSpeaker) ? s.otherSpeaker : []
        for (const t of [...selfArr, ...otherArr]) { if (t && !out.has(t)) out.add(t) }
      }
      const personaTemplates = new Set()
      const looksFlatSyntax = syntax.self || syntax.otherSpeaker
      if (looksFlatSyntax) {
        collectFromSyntaxObj(syntax, personaTemplates)
      } else {
        for (const s of Object.values(syntax)) { collectFromSyntaxObj(s, personaTemplates) }
      }
      if (personaTemplates.size > 0) {
        const seen = new Set()
        const out = []
        for (const t of personaTemplates) {
          if (!seen.has(t)) {
            seen.add(t)
            out.push(t)
          }
        }
        for (const t of mergedTemplates) {
          if (!seen.has(t)) {
            seen.add(t)
            out.push(t)
          }
        }
        mergedTemplates = out
      }
    }
    this.tasteConfig = this.tasteConfig || {}
    this.tasteConfig.lexicon = mergedLex
    this.tasteConfig.templates = mergedTemplates
    this.buckets = this._initBuckets()
  }

  applyPersona(persona) {
    if (!persona || typeof persona !== 'object') return
    const lexicon = persona.lexicon || null
    const syntax = persona.syntax || null
    this.applyLexiconSyntaxOverrides({ lexicon, syntax })
  }

  async observeUtterance({ text, speakerId = null, targetId = null, direction = 'incoming', context = {} }) {
    if (!text || !text.trim()) return null
    const stanceLabel = await this._classifyStance(text)
    const stance = this._normalizeStance(stanceLabel)
    const ext = await this._extractTemplateAndLexicon(text)
    this._storeExtraction(stance, ext)
    if (speakerId && targetId && this.relational) this._updateRelationalFromStance(speakerId, targetId, stance, direction, context)
    return { stance, ...ext }
  }

  getGenerationConfig(agentId, targetId = null, fallback = null) {
    const stanceBand = this._inferStanceBand(agentId, targetId)
    const bucket = this.buckets[stanceBand] || this.buckets.neutral
    const bT = this._getbT(), bL = this._getbL()
    const fbTemplates = (fallback && Array.isArray(fallback.templates) && fallback.templates.length) ? fallback.templates : bT
    const fbLexicon = (fallback && fallback.lexicon) ? fallback.lexicon : bL
    if (!bucket) return { stance: stanceBand, templates: fbTemplates, lexicon: this._normalizeLexicon(fbLexicon) }
    const { templates: learnedTemplates, lexicon: learnedLexicon } = this._extractLearnedFromBucket(bucket, bT, bL)
    const templates = this._composeTemplates(learnedTemplates, fbTemplates)
    let lexicon = this._composeLexicon(learnedLexicon, fbLexicon)
    lexicon = this._boostLearnedInLexicon(lexicon, learnedLexicon)
    return { stance: stanceBand, templates, lexicon }
  }

  getLexDetails(agentId = null, targetId = null) {
    const stanceBand = this._inferStanceBand(agentId, targetId)
    const bucket = this.buckets[stanceBand] || this.buckets.neutral
    if (!bucket) return null
    const bT = this._getbT()
    const bL = this._getbL()
    const { templates: learnedTemplates, lexicon: learnedLexicon } = this._extractLearnedFromBucket(bucket, bT, bL)
    const lx = this._normalizeLexicon(bucket.lexicon)
    return {
      stance: stanceBand,
      totalTemplates: bucket.templates.length,
      totalLexicon: {
        nouns: lx.nouns.length,
        verbs: lx.verbs.length,
        adjectives: lx.adjectives.length,
        adverbs: lx.adverbs.length,
        conjunctions: lx.conjunctions.length,
        pronouns: lx.pronouns.length,
        articles: lx.articles.length,
        prepositions: lx.prepositions.length,
        auxiliaries: lx.auxiliaries.length,
        modals: lx.modals.length
      },
      learnedTemplates,
      learnedLexicon
    }
  }

  exportConfig() {
    return {
      buckets: this.buckets,
      cfg: {
        minTemplatesPerStance: this.cfg.minTemplatesPerStance,
        minLexiconPerPos: this.cfg.minLexiconPerPos
      }
    }
  }

  importConfig(saved) {
    if (!saved || !saved.buckets) return
    this.buckets = {
      defensive: this._normalizeBucket(saved.buckets.defensive),
      neutral: this._normalizeBucket(saved.buckets.neutral),
      supportive: this._normalizeBucket(saved.buckets.supportive)
    }
  }

  _getBaseTemplates() {
    const rT = this.tasteConfig.templates
    if (Array.isArray(rT) && rT.length) return rT
    return DEFAULT_TEMPLATES
  }

  _getBaseLexicon() {
    const rL = this.tasteConfig.lexicon
    if (rL && Object.keys(rL).length) return rL
    return DEFAULT_LEXICON
  }

  _makeEmptyLexicon() {
    return {
      nouns: [],
      verbs: [],
      adjectives: [],
      adverbs: [],
      conjunctions: [],
      pronouns: [],
      articles: [],
      prepositions: [],
      auxiliaries: [],
      modals: []
    }
  }

  _initBuckets() {
    const bL = this._getbL()
    const bT = this._getbT()
    const seedLexicon = () => this._cloneLexicon(bL) || this._makeEmptyLexicon()
    return {
      defensive: { templates: [...bT], lexicon: seedLexicon() },
      neutral: { templates: [...bT], lexicon: seedLexicon() },
      supportive: { templates: [...bT], lexicon: seedLexicon() }
    }
  }

  _getbT() {
    const rT = this.tasteConfig.templates
    if (Array.isArray(rT) && rT.length) return rT
    return DEFAULT_TEMPLATES
  }

  _getbL() {
    const rL = this.tasteConfig.lexicon
    if (rL && Object.keys(rL).length) return rL
    return DEFAULT_LEXICON
  }

  _normalizeBucket(bucket = {}) {
    return {
      templates: Array.isArray(bucket.templates) ? bucket.templates : [],
      lexicon: this._normalizeLexicon(bucket.lexicon)
    }
  }

  _normalizeLexicon(lexicon = {}) {
    const ensure = (arr) => Array.isArray(arr) ? arr : []
    return {
      nouns: ensure(lexicon.nouns),
      verbs: ensure(lexicon.verbs),
      adjectives: ensure(lexicon.adjectives),
      adverbs: ensure(lexicon.adverbs),
      conjunctions: ensure(lexicon.conjunctions),
      pronouns: ensure(lexicon.pronouns),
      articles: ensure(lexicon.articles),
      prepositions: ensure(lexicon.prepositions),
      auxiliaries: ensure(lexicon.auxiliaries),
      modals: ensure(lexicon.modals)
    }
  }

  _extractLearnedFromBucket(bucket, bT, bL) {
    const baseT = Array.isArray(bT) ? bT : []
    const bucketTemplates = Array.isArray(bucket.templates) ? bucket.templates : []
    const learnedTemplates = bucketTemplates.filter(t => !baseT.includes(t))
    const bucketLex = this._normalizeLexicon(bucket.lexicon)
    const baseLex = this._normalizeLexicon(bL)
    const learnedLex = {}
    for (const key of POS_KEYS) {
      const baseSet = new Set(baseLex[key])
      learnedLex[key] = bucketLex[key].filter(token => !baseSet.has(token))
    }
    return {
      templates: learnedTemplates,
      lexicon: learnedLex
    }
  }

  _composeTemplates(learnedTemplates, bT) {
    const base = Array.isArray(bT) ? bT : []
    const learned = Array.isArray(learnedTemplates) ? learnedTemplates : []
    if (!learned.length) return base
    const r = typeof this.cfg.baseTemplateRetention === 'number' ? Math.max(0, Math.min(1, this.cfg.baseTemplateRetention)) : DEFAULT_BASE_TEMPLATE_RETENTION
    const trimmedBase = base.length && r < 1 ? base.slice(0, Math.max(1, Math.floor(base.length * r))) : base
    const seen = new Set(), out = []
    for (const t of learned) {
      if (!seen.has(t)) {
        seen.add(t)
        out.push(t)
      }
    }
    for (const t of trimmedBase) {
      if (!seen.has(t)) {
        seen.add(t)
        out.push(t)
      }
    }
    return out
  }

  _cloneLexicon(lexicon = {}) {
    const n = this._normalizeLexicon(lexicon)
    return {
      nouns: [...n.nouns],
      verbs: [...n.verbs],
      adjectives: [...n.adjectives],
      adverbs: [...n.adverbs],
      conjunctions: [...n.conjunctions],
      pronouns: [...n.pronouns],
      articles: [...n.articles],
      prepositions: [...n.prepositions],
      auxiliaries: [...n.auxiliaries],
      modals: [...n.modals]
    }
  }

  _loadConfigs() {
    const raw = process.env.MERGER_CONFIGS
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
          .map(entry => ({
            apiKey: entry.apiKey,
            model: entry.model || this.cfg.defaultModel,
            baseURL: entry.baseURL
          }))
          .filter(c => c.apiKey)
      }
    } catch (err) {
      console.warn('[Merger] Failed to parse MERGER_CONFIGS:', err.message)
    }
    return []
  }

  _pickRandomConfig() {
    if (!this.configs.length) return null
    const idx = Math.floor(Math.random() * this.configs.length)
    return this.configs[idx]
  }

  async _callChatCompletion(cfg, { system, user, maxTokens = 256, responseFormat = null } = {}) {
    const model = cfg.model || this.cfg.defaultModel
    const root = (cfg.baseURL && cfg.baseURL.trim()) || 'https://api.openai.com/v1'
    const trimmedRoot = root.replace(/\/+$/, '')
    const url = `${trimmedRoot}/chat/completions`
    const payload = {
      model,
      messages: [{ role: 'system', content: system || '' }, { role: 'user', content: user || '' }],
      max_completion_tokens: maxTokens,
      stream: false
    }
    if (responseFormat === 'json' && /openai\.com/i.test(root)) payload.response_format = { type: 'json_object' }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`LLM error: ${res.status} ${res.statusText} ${errText}`)
    }
    const data = await res.json()
    const mc = data.choices?.[0]?.message?.content
    if (typeof mc === 'string') return mc.trim() || ''
    if (Array.isArray(mc)) {
      return mc.map(part => {
        if (!part) return ''
        if (typeof part === 'string') return part
        if (typeof part.text === 'string') return part.text
        if (part.text && typeof part.text.value === 'string') return part.text.value
        return ''
      }).join('').trim()
    }
    if (mc && typeof mc === 'object') {
      if (typeof mc.text === 'string') return mc.text.trim()
      if (mc.text && typeof mc.text.value === 'string') return mc.text.value.trim()
      return String(mc).trim()
    }
    return ''
  }

  async _classifyStance(text) {
    const cfg = this._pickRandomConfig()
    if (!cfg || !cfg.apiKey) return 'neutral'
    const sys = PROMPTS.stance.join('\n')
    try {
      const content = await this._callChatCompletion(cfg, {
        system: sys,
        user: text,
        maxTokens: 16
      })
      return content.toLowerCase() || 'neutral'
    } catch (err) {
      console.warn('[Merger] stance classification failed:', err.message)
      return 'neutral'
    }
  }

  async _tagPartsOfSpeech(text) {
    const cfg = this._pickRandomConfig()
    if (!cfg || !cfg.apiKey) return []
    const sys = PROMPTS.pos.join('\n')
    try {
      const content = await this._callChatCompletion(cfg, {
        system: sys,
        user: text,
        maxTokens: 512,
        responseFormat: 'json'
      })
      const cleaned = this._extractJsonObjectFromCompletion(content)
      if (!cleaned) return []
      let parsed
      try {
        parsed = JSON.parse(cleaned)
      } catch { return [] }
      return Array.isArray(parsed.tokens) ? parsed.tokens : []
    } catch (err) {
      console.warn('[Merger] POS tagging failed:', err.message)
      return []
    }
  }

  _normalizeStance(label) {
    const lc = (label || '').trim().toLowerCase()
    if (STANCE_LABELS.includes(lc)) return lc
    if (lc === 'hostile' || lc === 'aggressive') return 'defensive'
    if (lc === 'kind' || lc === 'reassuring' || lc === 'encouraging') return 'supportive'
    return 'neutral'
  }

  getDebugBucket(stanceBand = 'neutral') {
    const bucket = this.buckets?.[stanceBand]
    if (!bucket) return null
    return {
      stance: stanceBand,
      templates: bucket.templates.slice(-DEBUG_TEMPLATE_SAMPLE_SIZE),
      lexiconSample: {
        nouns: (bucket.lexicon.nouns || []).slice(0, DEBUG_LEXICON_SAMPLE_SIZE),
        verbs: (bucket.lexicon.verbs || []).slice(0, DEBUG_LEXICON_SAMPLE_SIZE),
        adjectives: (bucket.lexicon.adjectives || []).slice(0, DEBUG_LEXICON_SAMPLE_SIZE),
        adverbs: (bucket.lexicon.adverbs || []).slice(0, DEBUG_LEXICON_SAMPLE_SIZE),
        conjunctions: (bucket.lexicon.conjunctions || []).slice(0, DEBUG_LEXICON_SAMPLE_SIZE),
        pronouns: (bucket.lexicon.pronouns || []).slice(0, DEBUG_LEXICON_SAMPLE_SIZE),
        articles: (bucket.lexicon.articles || []).slice(0, DEBUG_LEXICON_SAMPLE_SIZE),
        prepositions: (bucket.lexicon.prepositions || []).slice(0, DEBUG_LEXICON_SAMPLE_SIZE),
        auxiliaries: (bucket.lexicon.auxiliaries || []).slice(0, DEBUG_LEXICON_SAMPLE_SIZE),
        modals: (bucket.lexicon.modals || []).slice(0, DEBUG_LEXICON_SAMPLE_SIZE)
      }
    }
  }

  async _extractTemplateAndLexicon(text) {
    const tT = await this._tagPartsOfSpeech(text).catch(() => null)
    if (!tT || !tT.length) return this._extractTemplateAndLexiconHeuristic(text)
    const lexicon = this._makeEmptyLexicon()
    const templateParts = []
    for (const { token, pos, verbForm, lemma } of tT) {
      if (!token) continue
      const bare = token.replace(/[.,!?;:()"]/g, '')
      if (!bare) {
        templateParts.push(token)
        continue
      }
      const p = (pos || '').toLowerCase()
      if (p === 'conjunction') {
        lexicon.conjunctions.push(bare)
        templateParts.push('{conjunction}')
      } else if (p === 'adverb') {
        lexicon.adverbs.push(bare)
        templateParts.push('{adverb}')
      } else if (p === 'adjective') {
        lexicon.adjectives.push(bare)
        templateParts.push('{adjective}')
      } else if (p === 'verb') {
        const base = (lemma && typeof lemma === 'string') ? lemma : bare
        lexicon.verbs.push(base)
        const vf = (verbForm || '').toLowerCase()
        if (vf === 'past') {
          templateParts.push('{verbPast}')
        } else if (vf === 'part') {
          templateParts.push('{verbPart}')
        } else if (vf === 'gerund') {
          templateParts.push('{verbGerund}')
        } else if (vf === 's3') {
          templateParts.push('{verb3rd}')
        } else {
          templateParts.push('{verb}')
        }
      } else if (p === 'noun') {
        lexicon.nouns.push(bare)
        templateParts.push('{noun}')
      } else if (p === 'pronoun') {
        lexicon.pronouns.push(bare)
        templateParts.push('{pronoun}')
      } else if (p === 'article' || p === 'det' || p === 'determiner') {
        lexicon.articles.push(bare)
        templateParts.push('{article}')
      } else if (p === 'preposition' || p === 'prep') {
        lexicon.prepositions.push(bare)
        templateParts.push('{preposition}')
      } else if (p === 'auxiliary' || p === 'aux') {
        lexicon.auxiliaries.push(bare)
        templateParts.push('{aux}')
      } else if (p === 'modal' || p === 'modal_verb') {
        lexicon.modals.push(bare)
        templateParts.push('{modal}')
      } else {
        templateParts.push(token)
      }
    }
    return { template: templateParts.join(' '), lexicon }
  }

  _extractTemplateAndLexiconHeuristic(text) {
    const cleaned = text.trim()
    const tokens = cleaned.split(/\s+/)
    const lexicon = this._makeEmptyLexicon()
    const parts = []
    for (const t of tokens) {
      const bare = t.replace(/[.,!?;:()"]/g, '')
      const lower = bare.toLowerCase()
      if (!bare) {
        parts.push(t)
        continue
      }
      if (this._looksLikeConjunction(lower)) {
        lexicon.conjunctions.push(bare)
        parts.push('{conjunction}')
      } else if (this._looksLikePronoun(lower)) {
        lexicon.pronouns.push(bare)
        parts.push('{pronoun}')
      } else if (this._looksLikeArticle(lower)) {
        lexicon.articles.push(bare)
        parts.push('{article}')
      } else if (this._looksLikePreposition(lower)) {
        lexicon.prepositions.push(bare)
        parts.push('{preposition}')
      } else if (this._looksLikeAuxiliary(lower)) {
        lexicon.auxiliaries.push(bare)
        parts.push('{aux}')
      } else if (this._looksLikeModal(lower)) {
        lexicon.modals.push(bare)
        parts.push('{modal}')
      } else if (this._looksLikeAdverb(lower)) {
        lexicon.adverbs.push(bare)
        parts.push('{adverb}')
      } else if (this._looksLikeAdjective(lower)) {
        lexicon.adjectives.push(bare)
        parts.push('{adjective}')
      } else if (this._looksLikeVerb(lower)) {
        lexicon.verbs.push(bare)
        parts.push('{verb}')
      } else {
        lexicon.nouns.push(bare)
        parts.push('{noun}')
      }
    }
    return { template: parts.join(' '), lexicon }
  }

  _composeLexicon(learnedLexicon, bL) {
    const l = this._normalizeLexicon(learnedLexicon)
    const b = this._normalizeLexicon(bL)
    const r = typeof this.cfg.bLRetention === 'number' ? Math.max(0, Math.min(1, this.cfg.bLRetention)) : DEFAULT_BASE_LEXICON_RETENTION
    const merge = (learnedArr, baseArr) => {
      if (!learnedArr.length) return baseArr
      const trimmedBase = baseArr.length && r < 1 ? baseArr.slice(0, Math.max(1, Math.floor(baseArr.length * r))) : baseArr
      const seen = new Set()
      const out = []
      for (const token of learnedArr) {
        if (!seen.has(token)) {
          seen.add(token)
          out.push(token)
        }
      }
      for (const token of trimmedBase) {
        if (!seen.has(token)) {
          seen.add(token)
          out.push(token)
        }
      }
      return out
    }
    return {
      nouns: merge(l.nouns, b.nouns),
      verbs: merge(l.verbs, b.verbs),
      adjectives: merge(l.adjectives, b.adjectives),
      adverbs: merge(l.adverbs, b.adverbs),
      conjunctions: merge(l.conjunctions, b.conjunctions),
      pronouns: merge(l.pronouns, b.pronouns),
      articles: merge(l.articles, b.articles),
      prepositions: merge(l.prepositions, b.prepositions),
      auxiliaries: merge(l.auxiliaries, b.auxiliaries),
      modals: merge(l.modals, b.modals)
    }
  }

  _boostLearnedInLexicon(fullLexicon, learnedLexicon = {}) {
    const full = this._normalizeLexicon(fullLexicon)
    const learned = this._normalizeLexicon(learnedLexicon)
    const out = this._makeEmptyLexicon()
    for (const key of POS_KEYS) {
      const baseArr = Array.isArray(full[key]) ? full[key] : []
      const learnedSet = new Set(learned[key] || [])
      const boosted = []
      for (const token of baseArr) {
        boosted.push(token)
        if (learnedSet.has(token)) boosted.push(token)
      }
      out[key] = boosted
    }
    return out
  }

  _storeExtraction(stance, extraction) {
    const bucket = this.buckets[stance] || this.buckets.neutral
    if (!bucket) return
    const { template, lexicon } = extraction
    if (template && template.length && !bucket.templates.includes(template)) bucket.templates.push(template)
    const dst = bucket.lexicon
    Object.keys(lexicon).forEach(pos => {
      const list = lexicon[pos] || []
      if (!Array.isArray(dst[pos])) dst[pos] = []
      for (const token of list) { if (!dst[pos].includes(token)) dst[pos].push(token) }
    })
  }

  _buckethCm(bucket) {
    if (!bucket) return false
    const tCount = bucket.templates.length
    if (tCount < this.cfg.minTemplatesPerStance) return false
    const lx = this._normalizeLexicon(bucket.lexicon)
    for (const key of POS_KEYS) {
      if (lx[key].length < this.cfg.minLexiconPerPos) return false
    }
    return true
  }

  _mergeLexiconWithFallback(primary, fallback) {
    const p = this._normalizeLexicon(primary)
    const f = this._normalizeLexicon(fallback)
    const mergeList = (a, b) => {
      const seen = new Set(a)
      const out = [...a]
      for (const item of b) {
        if (!seen.has(item)) {
          seen.add(item)
          out.push(item)
        }
      }
      return out
    }
    return {
      nouns: mergeList(p.nouns, f.nouns),
      verbs: mergeList(p.verbs, f.verbs),
      adjectives: mergeList(p.adjectives, f.adjectives),
      adverbs: mergeList(p.adverbs, f.adverbs),
      conjunctions: mergeList(p.conjunctions, f.conjunctions),
      pronouns: mergeList(p.pronouns, f.pronouns),
      articles: mergeList(p.articles, f.articles),
      prepositions: mergeList(p.prepositions, f.prepositions),
      auxiliaries: mergeList(p.auxiliaries, f.auxiliaries),
      modals: mergeList(p.modals, f.modals)
    }
  }

  _inferStanceBand(agentId, targetId) {
    if (!this.relational || !agentId || !targetId) return 'neutral'
    try {
      const interaction = this.relational.getInteraction(agentId, targetId)
      const stance = interaction.state.stance || 'cautious'
      return this._mapRelationalStanceToBand(stance)
    } catch {
      return 'neutral'
    }
  }

  _mapRelationalStanceToBand(relationalStance) {
    const s = (relationalStance || '').toLowerCase()
    if (s === 'defensive') return 'defensive'
    if (s === 'cautious') return 'neutral'
    if (s === 'collaborative' || s === 'intimate') return 'supportive'
    return 'neutral'
  }

  _updateRelationalFromStance(speakerId, targetId, stance, direction, context = {}) {
    if (!this.relational || typeof this.relational.updateInteractionState !== 'function') return
    const baseDelta = this._stanceToRelationalDelta(stance)
    let scale = 1
    if (typeof context.score === 'number' && !Number.isNaN(context.score)) {
      const clampedScore = Math.max(0, Math.min(1, context.score))
      scale *= RELATIONAL_SCORE_OFFSET + RELATIONAL_SCORE_SCALE * clampedScore
    }
    const delta = {
      trust: (baseDelta.trust || 0) * scale,
      comfort: (baseDelta.comfort || 0) * scale,
      alignment: (baseDelta.alignment || 0) * scale,
      energy: (baseDelta.energy || 0) * scale
    }
    try {
      if (direction === 'incoming') {
        this.relational.updateInteractionState(targetId, speakerId, delta)
      } else {
        this.relational.updateInteractionState(speakerId, targetId, delta)
      }
    } catch { }
  }

  _stanceToRelationalDelta(stance) {
    if (stance === 'supportive') return SUPPORTIVE_RELATIONAL_DELTA
    if (stance === 'defensive') return DEFENSIVE_RELATIONAL_DELTA
    return NEUTRAL_RELATIONAL_DELTA
  }

  async _tagPartsOfSpeech(text) {
    const cfg = this._pickRandomConfig()
    if (!cfg || !cfg.apiKey) return []
    const sys = PROMPTS.pos.join('\n')
    try {
      const content = await this._callChatCompletion(cfg, {
        system: sys,
        user: text,
        maxTokens: 256,
        responseFormat: 'json'
      })
      let parsed
      try {
        const cleaned = this._extractJsonObjectFromCompletion(content)
        if (!cleaned) return []
        parsed = JSON.parse(cleaned)
      } catch (e) {
        console.warn('[Merger] POS tagging failed, falling back to heuristic:', e.message)
        parsed = []
      }
      return Array.isArray(parsed.tokens) ? parsed.tokens : []
    } catch (err) {
      console.warn('[Merger] POS tagging failed:', err.message)
      return []
    }
  }

  _extractJsonObjectFromCompletion(raw) {
    if (!raw) return ''
    let s = String(raw).trim()
    if (s.startsWith('```')) {
      const lines = s.split('\n')
      lines.shift()
      if (lines.length && lines[lines.length - 1].trim().startsWith('```')) lines.pop()
      s = lines.join('\n').trim()
    }
    const first = s.indexOf('{')
    const last = s.lastIndexOf('}')
    if (first !== -1 && last !== -1 && last > first) return s.slice(first, last + 1).trim()
    return s
  }

  _looksLikeConjunction(token) { return CONJUNCTIONS.includes(token) }

  _looksLikePronoun(token) { return PRONOUNS.includes(token) }

  _looksLikeArticle(token) { return token === 'a' || token === 'an' || token === 'the' }

  _looksLikePreposition(token) { return PREP.includes(token) }

  _looksLikeAuxiliary(token) { return AUX.includes(token) }

  _looksLikeModal(token) { return MODALS.includes(token) }

  _looksLikeAdverb(token) { return token.endsWith('ly') }

  _looksLikeAdjective(token) { return token.endsWith('ive') || token.endsWith('ous') || token.endsWith('ful') }

  _looksLikeVerb(token) { return token.endsWith('ing') || token.endsWith('ed') }
}
