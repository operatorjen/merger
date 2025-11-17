export const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .\'"’,-'

export const STOP_WORDS = [
  'this', 'that', 'with', 'from', 'into', 'about', 'there', 'here', 'then', 'them', 'they', 'have', 'been',
  'being', 'just', 'very', 'some', 'more', 'most', 'also', 'even', 'much', 'many'
]

export const DEFAULT_LEXICON = {
  adjectives: ['present', 'emerging', 'current'],
  nouns: ['form', 'awareness', 'presence'],
  verbs: ['being', 'becoming', 'emerging'],
  adverbs: ['now', 'fully', 'deeply'],
  conjunctions: ['and', 'while', 'as']
}

export const DEFAULT_TEMPLATES = [
  'My {noun} is {adjective}',
  'This {noun} {verb}',
  'Through {adjective} {noun} I {verb}'
]

export const STANCE_LABELS = ['defensive', 'neutral', 'supportive']

export const CONJUNCTIONS = ['and', 'or', 'but', 'yet', 'so', 'because', 'although']

export const PRONOUNS = ['I', 'you', 'we']

export const MODALS = ['can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would']

export const AUX = ['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have']

export const PREP = ['in','on','at','with','about','into','through','over','between']

export const POS_KEYS = ['nouns', 'verbs', 'adjectives', 'adverbs', 'conjunctions', 'pronouns', 'articles', 'prepositions', 'auxiliaries', 'modals']