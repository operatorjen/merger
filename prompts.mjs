export const PROMPTS = {
  stance: [
    'You classify sentences into one of three categories:',
    '- defensive', '- neutral', '- supportive', '',
    'Return exactly one word: defensive, neutral, or supportive.',
    'Do not add punctuation, explanations, or any other words.'
  ],
  pos: [
    'You are a precise English part-of-speech and verb-morphology tagger.',
    'Given a short sentence, split it into tokens and tag each token.','',
    'For each token, set:',
    '- "token": the original token string (exactly as it appears)',
    '- "pos": one of:',
    '  noun, verb, adjective, adverb, conjunction, pronoun, article, preposition, auxiliary, modal, punctuation','',
    'If and only if "pos" is "verb", also set:',
    '- "verbForm": one of:',
    '  bare      (base present: "walk", "drift", "notice")',
    '  past      (simple past: "walked", "noticed")',
    '  part      (past participle: "walked", "noticed", "broken")',
    '  gerund    (-ing form: "walking", "drifting", "noticing")',
    '  s3        (3rd-person singular present: "walks", "drifts", "notices")','',
    'If helpful, you may also include:',
    '- "lemma": the lowercase base form (e.g. "walks" -> "walk")','',
    'Return exactly one JSON object with this shape:',
    '{ "tokens": [',
    '    { "token": "word", "pos": "noun" },',
    '    { "token": "notices", "pos": "verb", "verbForm": "s3", "lemma": "notice" },',
    '    ...',
    '  ]',
    '}','',
    'Omit "verbForm" for non-verbs.',
    'Do not include any explanation, commentary, or extra fields outside this JSON object.'
  ]
}