import { Merger } from './index.mjs'

function banner(title) {
  console.log(`\n\n${title}`)
  console.log('='.repeat(60))
}

function section(title) { console.log(`\n— ${title} —`) }

function assert(condition, message) { if (!condition) throw new Error(message || 'Assertion failed') }

class FakeRelational {
  constructor() {
    this.interactions = new Map()
    this.updateCalls = []
  }

  _key(fromId, toId) { return `${fromId}->${toId}` }

  getInteraction(fromId, toId) {
    const key = this._key(fromId, toId)
    if (!this.interactions.has(key)) {
      this.interactions.set(key, {
        fromId,
        toId,
        engagementWillingness: 0.5,
        state: {
          stance: 'collaborative',
          trust: 0.5,
          comfort: 0.5,
          alignment: 0.5,
          energy: 0.5
        }
      })
    }
    return this.interactions.get(key)
  }

  updateInteractionState(fromId, toId, delta) {
    const interaction = this.getInteraction(fromId, toId)
    const s = interaction.state
    s.trust += delta.trust || 0
    s.comfort += delta.comfort || 0
    s.alignment += delta.alignment || 0
    s.energy += delta.energy || 0
    this.updateCalls.push({ fromId, toId, delta })
    return interaction
  }
}

function buildBaseTasteConfig() {
  return {
    templates: [
      'My {noun} is {adjective}',
      'This {noun} feels {adjective}',
      'Through {adjective} {noun} {pronoun} {verb}'
    ],
    lexicon: {
      nouns: ['pattern', 'conversation', 'signal'],
      adjectives: ['supportive', 'defensive', 'neutral', 'attentive'],
      verbs: ['notice', 'sense', 'explore'],
      adverbs: ['gently', 'carefully', 'tentatively'],
      conjunctions: ['and', 'but', 'yet'],
      pronouns: ['I']
    }
  }
}

function buildFallbackConfig(tC) {
  return {
    templates: tC.templates || [],
    lexicon: tC.lexicon || {
      nouns: [],
      adjectives: [],
      verbs: [],
      adverbs: [],
      conjunctions: [],
      pronouns: []
    }
  }
}

function patchDeterministicStance(merger) {
  if (process.env.NODE_ENV === 'test') {
    merger._classifyStance = async (text) => {
      const lower = (text || '').toLowerCase()
      if (lower.includes('defensive') || lower.includes('closed off')) return 'defensive'
      if (lower.includes('support') || lower.includes('supportive') || lower.includes('open')) return 'supportive'
      if (lower.includes('neutral')) return 'neutral'
      return 'neutral'
    }
  }
}

function patchDeterministicPOS(merger) {
  if (process.env.NODE_ENV === 'test') merger._tagPartsOfSpeech = async () => { return [] }
}

async function basicInitializationAndFallbackTest() {
  banner('MERGER BASIC INITIALIZATION TEST')
  const tC = buildBaseTasteConfig()
  const fallback = buildFallbackConfig(tC)
  const merger = new Merger(tC, null, null, { minTemplatesPerStance: 1, minLexiconPerPos: 1 })
  const cfg = merger.getGenerationConfig('Alpha', 'Beta', fallback)

  section('Config Shape Verification')
  console.log('Generation config:', cfg)
  assert(Array.isArray(cfg.templates), 'templates should be an array')
  assert(cfg.templates.length > 0, 'templates should not be empty')
  assert(typeof cfg.lexicon === 'object', 'lexicon should be an object')
  assert(Array.isArray(cfg.lexicon.nouns), 'lexicon.nouns should be an array')
  assert(cfg.lexicon.nouns.length > 0, 'lexicon.nouns should have at least one entry')
  assert(cfg.lexicon.pronouns.length > 0, 'lexcicon.pronouns should have at least one entry')
  console.log('✅ Merger initialization and fallback config look valid')
}

async function learningAndStanceRoutingTest() {
  banner('MERGER LEARNING AND STANCE ROUTING TEST')
  const tC = buildBaseTasteConfig()
  const fallback = buildFallbackConfig(tC)
  const relational = new FakeRelational()
  const merger = new Merger(tC, relational, null, {
    minTemplatesPerStance: 1,
    minLexiconPerPos: 1
  })
  patchDeterministicStance(merger)
  patchDeterministicPOS(merger)
  section('Initial Generation Config (before learning)')
  const initialCfg = merger.getGenerationConfig('Alpha', 'Beta', fallback)
  console.log('Initial config:', initialCfg)
  assert(Array.isArray(initialCfg.templates) && initialCfg.templates.length > 0, 'Initial templates should not be empty')
  const bS = merger.exportConfig()
  const bSt = bS.buckets.supportive.templates.slice()
  const bSn = (bS.buckets.supportive.lexicon.nouns || []).slice()

  section('Supportive bucket before learning')
  console.log('Supportive templates (before):', bSt)
  console.log('Supportive nouns (before):', bSn)
  const utterances = [
    'I notice this pattern feels supportive and spacious',
    'This conversation feels gently attentive and aligned',
    'I sense a more open, supportive direction between us'
  ]
  section('Observing Supportive Utterances')
  for (const text of utterances) {
    console.log(`Observing utterance: "${text}"`)
    await merger.observeUtterance({
      text,
      speakerId: 'Alpha',
      targetId: 'Beta',
      direction: 'outgoing',
      context: {
        stance: 'supportive',
        trustLevel: 0.7,
        comfortLevel: 0.65
      }
    })
  }

  section('Relational Coupling Check')
  console.log('Relational update calls:', relational.updateCalls)
  assert(relational.updateCalls.length > 0, 'Merger should have pushed at least one relational update')
  const interaction = relational.getInteraction('Alpha', 'Beta')
  console.log('Updated interaction state:', interaction.state)
  assert(interaction.state.trust > 0.5, 'Trust should have increased after supportive utterances')
  assert(interaction.state.comfort > 0.5, 'Comfort should have increased after supportive utterances')
  const aS = merger.exportConfig()
  const aSt = aS.buckets.supportive.templates.slice()
  const aSn = (aS.buckets.supportive.lexicon.nouns || []).slice()

  section('Supportive bucket after learning')
  console.log('Supportive templates (after):', aSt)
  console.log('Supportive nouns (after):', aSn)
  const tCb = bSt.length
  const tCa = aSt.length
  const nCb = bSn.length
  const nCa = aSn.length
  assert(tCa >= tCb, 'Supportive bucket should not lose templates after learning')
  assert(tCa > tCb || nCa > nCb, 'Supportive bucket should gain templates or nouns after learning')

  section('Generation Config After Learning')
  const learnedCfg = merger.getGenerationConfig('Alpha', 'Beta', fallback)
  console.log('Learned config:', learnedCfg)
  assert(Array.isArray(learnedCfg.templates) && learnedCfg.templates.length > 0, 'Learned templates should not be empty')
  console.log('✅ Merger learns from supportive utterances and nudges relational stance as expected')
}

async function exportImportRoundTripTest() {
  banner('MERGER EXPORT / IMPORT ROUND TRIP TEST')
  const tC = buildBaseTasteConfig()
  const fallback = buildFallbackConfig(tC)
  const relational = new FakeRelational()
  const merger = new Merger(tC, relational, null, { minTemplatesPerStance: 1, minLexiconPerPos: 1 })
  patchDeterministicStance(merger)
  patchDeterministicPOS(merger)
  const samples = [
    {
      text: 'This pattern feels defensive and closed off',
      context: { stance: 'defensive', trustLevel: 0.3, comfortLevel: 0.3 }
    },
    {
      text: 'I notice a more neutral, observational stance here',
      context: { stance: 'neutral', trustLevel: 0.5, comfortLevel: 0.5 }
    },
    {
      text: 'This conversation feels more supportive and trusting now',
      context: { stance: 'supportive', trustLevel: 0.8, comfortLevel: 0.8 }
    }
  ]

  section('Priming Merger With Mixed Utterances')
  for (const s of samples) {
    console.log(`Priming: "${s.text}"`)
    await merger.observeUtterance({
      text: s.text,
      speakerId: 'Alpha',
      targetId: 'Beta',
      direction: 'outgoing',
      context: s.context
    })
  }
  const bS = merger.exportConfig()

  section('Buckets before export')
  console.log('Buckets (before):', bS.buckets)
  
  const snapshot = merger.exportConfig()
  section('Exported Snapshot')
  console.log('Snapshot:', snapshot)
  assert(snapshot && typeof snapshot === 'object', 'Snapshot must be an object')
  assert(snapshot.buckets && typeof snapshot.buckets === 'object', 'Snapshot should contain buckets')
  const relational2 = new FakeRelational()
  const merger2 = new Merger(buildBaseTasteConfig(), relational2, null, { minTemplatesPerStance: 1, minLexiconPerPos: 1 })
  patchDeterministicStance(merger2)
  patchDeterministicPOS(merger2)
  section('Importing Snapshot Into Fresh Merger')
  merger2.importConfig(snapshot)
  const aS = merger2.exportConfig()
  console.log('Buckets (after):', aS.buckets)
  const beforeKeys = Object.keys(bS.buckets)
  const afterKeys = Object.keys(aS.buckets)
  assert(JSON.stringify(beforeKeys) === JSON.stringify(afterKeys), 'Bucket keys should be preserved across export/import')
  for (const key of beforeKeys) {
    const b1 = bS.buckets[key], b2 = aS.buckets[key]
    assert(Array.isArray(b1.templates) && Array.isArray(b2.templates), `Bucket "${key}" templates must be arrays`)
    assert(Array.isArray(b1.lexicon.nouns) && Array.isArray(b2.lexicon.nouns), `Bucket "${key}" lexicon.nouns must be arrays`)
    assert(JSON.stringify(b1.templates) === JSON.stringify(b2.templates), `Bucket "${key}" templates should match before/after import`)
  }
  const cfgBefore = merger.getGenerationConfig('Alpha', 'Beta', fallback)
  const cfgAfter = merger2.getGenerationConfig('Alpha', 'Beta', fallback)
  section('Config comparison before/after import')
  console.log('Config before:', cfgBefore)
  console.log('Config after:', cfgAfter)
  assert(Array.isArray(cfgAfter.templates) && cfgAfter.templates.length > 0, 'Config after import should have templates')
  console.log('✅ Merger export/import round trip preserves learned configuration')
}

async function runAllMergerTests() {
  try {
    await basicInitializationAndFallbackTest()
    await learningAndStanceRoutingTest()
    await exportImportRoundTripTest()
    banner('ALL MERGER TESTS COMPLETE')
    process.exit(1)
  } catch (error) {
    console.error('\n❌ MERGER TESTS FAILED:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

await runAllMergerTests()