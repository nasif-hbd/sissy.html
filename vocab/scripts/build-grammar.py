"""Build the shipped grammar bank.

Written by hand rather than generated: grammar questions need a stated rule and
one defensible answer, and a model asked for 200 of them will produce plausible
items with two right answers. Each item carries the rule it tests so the app can
explain a wrong answer without an API call.
"""
import json

def q(level, topic, prompt, options, answer, why):
    assert options[answer], "answer index out of range"
    assert len(set(options)) == len(options), f"repeated option in: {prompt}"
    return {"lv": level, "t": topic, "q": prompt, "o": options, "a": answer, "w": why}

ITEMS = [
  # ── tenses ───────────────────────────────────────────────────────────────
  q('A2','Present simple','She ____ to work by bus every day.',['go','goes','going','gone'],1,
    'Third person singular in the present simple takes -s: he/she/it goes.'),
  q('A2','Present continuous','Be quiet — the baby ____.',['sleeps','is sleeping','slept','sleep'],1,
    'Something happening right now takes the present continuous: is + -ing.'),
  q('A2','Past simple','We ____ the match last Friday.',['win','won','have won','winning'],1,
    'A finished time ("last Friday") takes the past simple.'),
  q('B1','Present perfect','I ____ in this city since 2019.',['live','lived','have lived','am living'],2,
    '"Since" marks something starting in the past and still true: present perfect.'),
  q('B1','Present perfect vs past','____ you ever ____ to Japan?',['Did / go','Have / been','Have / went','Are / going'],1,
    'Life experience with no stated time takes the present perfect: have been.'),
  q('B1','Past continuous','I ____ dinner when the phone rang.',['cooked','was cooking','have cooked','cook'],1,
    'A longer action interrupted by a shorter one takes the past continuous.'),
  q('B1','Past perfect','By the time we arrived, the film ____.',['started','has started','had started','was starting'],2,
    'The earlier of two past events takes the past perfect: had started.'),
  q('B2','Future forms','Look at those clouds — it ____ rain.',['will','is going to','shall','would'],1,
    'Present evidence for a future event takes "going to", not "will".'),
  q('B2','Future perfect','By next June I ____ here for ten years.',['work','will work','will have worked','have worked'],2,
    'Completed before a future point: will have + past participle.'),
  q('B1','Present perfect continuous','My eyes hurt — I ____ at this screen all morning.',
    ['stare','have stared','have been staring','stared'],2,
    'An action continuing up to now, with the duration in focus, takes have been + -ing.'),

  # ── articles and determiners ──────────────────────────────────────────────
  q('A2','Articles','She is ____ engineer at a shipping firm.',['a','an','the','—'],1,
    '"An" before a vowel sound: an engineer.'),
  q('A2','Articles','____ sun rose at six.',['A','An','The','—'],2,
    'Unique things take "the": the sun, the moon, the earth.'),
  q('B1','Articles','I do not drink ____ coffee in the evening.',['a','the','—','an'],2,
    'An uncountable noun in a general sense takes no article.'),
  q('B1','Quantifiers','There is not ____ milk left.',['many','much','few','several'],1,
    '"Much" goes with uncountable nouns; "many" with countable ones.'),
  q('B1','Quantifiers','____ of my friends live abroad.',['Much','Every','Several','Little'],2,
    '"Several" takes a plural countable noun and a plural verb.'),
  q('B2','Quantifiers','She has ____ patience for excuses.',['few','a few','little','a little'],2,
    '"Little" (without "a") means almost none, and pairs with an uncountable noun.'),

  # ── prepositions ─────────────────────────────────────────────────────────
  q('A2','Prepositions','The meeting is ____ Monday morning.',['in','on','at','by'],1,
    'Days and dates take "on": on Monday.'),
  q('A2','Prepositions','We will be there ____ six o\'clock.',['in','on','at','to'],2,
    'Clock times take "at": at six o\'clock.'),
  q('B1','Prepositions','She has worked here ____ three years.',['since','for','from','during'],1,
    '"For" takes a length of time; "since" takes a starting point.'),
  q('B1','Prepositions','He is very good ____ explaining difficult ideas.',['in','on','at','for'],2,
    '"Good at" is the fixed pairing, and a verb after a preposition takes -ing.'),
  q('B2','Prepositions','The decision depends ____ the budget.',['of','on','to','from'],1,
    '"Depend" is always followed by "on".'),
  q('B2','Prepositions','I must apologise ____ being late.',['of','for','to','about'],1,
    'You apologise TO a person FOR a thing.'),

  # ── conditionals ─────────────────────────────────────────────────────────
  q('B1','First conditional','If it ____ tomorrow, we will stay in.',['rains','will rain','rained','would rain'],0,
    'First conditional: if + present simple, then will + infinitive. Never "will" in the if-clause.'),
  q('B2','Second conditional','If I ____ you, I would take the job.',['am','was','were','will be'],2,
    'The second conditional uses "were" for every person: if I were you.'),
  q('B2','Third conditional','If she ____ harder, she would have passed.',
    ['studied','had studied','would study','has studied'],1,
    'Third conditional: if + past perfect, then would have + past participle.'),
  q('C1','Mixed conditional','If I had taken that job, I ____ in Dhaka now.',
    ['would live','would have lived','will live','lived'],0,
    'A past condition with a present result: had + past participle, then would + infinitive.'),

  # ── modals ───────────────────────────────────────────────────────────────
  q('A2','Modals','You ____ smoke in the hospital.',['must not','do not must','not must','must not to'],0,
    'Modals take no auxiliary and no "to": must not smoke.'),
  q('B1','Modals','You ____ be tired after that journey.',['must','can','should','may not'],0,
    '"Must" expresses a confident deduction, not only obligation.'),
  q('B1','Modals','I ____ swim when I was six.',['can','could','was able','may'],1,
    '"Could" is the past of general ability.'),
  q('B2','Modals','She ____ the email — she never received it.',
    ['must have sent','cannot have sent','should send','might send'],1,
    '"Cannot have + past participle" expresses certainty that something did NOT happen.'),
  q('B2','Modals','You ____ told me — I would have helped.',
    ['should have','should','must have','ought'],0,
    '"Should have + past participle" is regret about the past.'),

  # ── passive and reported speech ──────────────────────────────────────────
  q('B1','Passive','The bridge ____ in 1890.',['built','was built','has built','is building'],1,
    'Passive past simple: was/were + past participle.'),
  q('B2','Passive','The results ____ tomorrow.',
    ['will announce','will be announced','are announcing','announce'],1,
    'The results receive the action, so the passive is needed: will be announced.'),
  q('B1','Reported speech','She said she ____ tired.',['is','was','has been','will be'],1,
    'Reported speech shifts the tense back one step: "I am" becomes "she was".'),
  q('B2','Reported speech','He asked me where ____.',
    ['do I live','I live','did I live','I lived'],3,
    'A reported question takes statement word order and a backshifted tense.'),

  # ── relative clauses and structure ───────────────────────────────────────
  q('B1','Relative clauses','The man ____ car was stolen called the police.',
    ['who','whose','which','whom'],1,
    '"Whose" marks possession: the man whose car.'),
  q('B2','Relative clauses','The book, ____ I read last year, is still my favourite.',
    ['that','which','what','who'],1,
    'A non-defining clause after a comma takes "which", never "that".'),
  q('B2','Gerund vs infinitive','I really enjoy ____ early.',['to get up','getting up','get up','got up'],1,
    '"Enjoy" is always followed by the -ing form.'),
  q('B2','Gerund vs infinitive','She agreed ____ the report by Friday.',
    ['finishing','to finish','finish','finished'],1,
    '"Agree" is followed by the infinitive with "to".'),
  q('B2','Gerund vs infinitive','I stopped ____ coffee because it kept me awake.',
    ['to drink','drinking','drink','drunk'],1,
    '"Stop + -ing" means you ended the habit; "stop to drink" means you paused in order to drink.'),
  q('C1','Inversion','Not only ____ late, but he also forgot the tickets.',
    ['he was','was he','he is','is he'],1,
    'A negative adverbial at the front inverts the subject and auxiliary: was he.'),

  # ── agreement, comparatives, word order ──────────────────────────────────
  q('A2','Comparatives','This exam was ____ than the last one.',
    ['difficult','more difficult','most difficult','difficulter'],1,
    'Adjectives of three or more syllables take "more", not "-er".'),
  q('A2','Superlatives','It is ____ film I have ever seen.',['the best','best','the better','better'],0,
    'A superlative takes "the": the best.'),
  q('B1','Subject–verb agreement','Each of the students ____ a folder.',['have','has','are having','were'],1,
    '"Each" is singular however many follow it, so the verb is singular.'),
  q('B1','Subject–verb agreement','The news ____ better today.',['are','is','have','were'],1,
    '"News" looks plural but takes a singular verb.'),
  q('B2','Subject–verb agreement','Neither the manager nor the staff ____ been told.',
    ['has','have','is','was'],1,
    'With "neither…nor", the verb agrees with the nearer subject: staff have.'),
  q('B1','Word order','She ____ goes to bed before midnight.',['never','not','no','nothing'],0,
    'Adverbs of frequency go before the main verb: she never goes.'),
  q('B2','Word order','I have ____ finished the first chapter.',['yet','already','still not','ever'],1,
    '"Already" is used in affirmative sentences; "yet" belongs in questions and negatives.'),

  # ── commonly confused ────────────────────────────────────────────────────
  q('B1','Confusables','The rain did not ____ our plans.',['effect','affect','affects','effects'],1,
    '"Affect" is the verb; "effect" is normally the noun.'),
  q('B1','Confusables','There are ____ chairs than people.',['less','fewer','little','least'],1,
    '"Fewer" for countable nouns, "less" for uncountable ones.'),
  q('B1','Confusables','____ going to be a long meeting.',['Its','It\'s','Its\'','Their'],1,
    '"It\'s" is "it is". "Its" without an apostrophe is the possessive.'),
  q('B2','Confusables','The company laid ____ two hundred workers.',['of','off','out','over'],1,
    '"Lay off" means to make redundant.'),
  q('B2','Confusables','I am looking forward to ____ from you.',['hear','hearing','heard','be hearing'],1,
    '"Looking forward to" ends in a preposition, so the verb takes -ing.'),
  q('C1','Confusables','The evidence ____ the theory.',
    ['comprises','compromises','corroborates','collaborates'],2,
    '"Corroborate" means to support with evidence; "collaborate" means to work together.'),
]

# integrity: no duplicate prompts, every answer in range, every item explained
seen = set()
for it in ITEMS:
    assert it['q'] not in seen, f"duplicate prompt: {it['q']}"
    seen.add(it['q'])
    assert 0 <= it['a'] < len(it['o'])
    assert len(it['w']) > 25, f"weak explanation: {it['q']}"
    assert len(it['o']) == 4, f"not four options: {it['q']}"

topics = sorted({i['t'] for i in ITEMS})
levels = sorted({i['lv'] for i in ITEMS})
out = {'count': len(ITEMS), 'topics': topics, 'levels': levels, 'items': ITEMS}
with open('data/grammar/bank.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False)
print(f"{len(ITEMS)} grammar items across {len(topics)} topics, levels {levels}")
for lv in levels:
    print(' ', lv, sum(1 for i in ITEMS if i['lv'] == lv))
