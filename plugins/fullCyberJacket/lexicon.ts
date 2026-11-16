/*
 * Sernicord FullCyberJacket — built-in lexicon (data only)
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Patterns are written in normalized form: lowercase ASCII, no diacritics (ż → z, ł → l, ó → o).
 * Leet, homoglyphs, repeated letters, separators and spaced-out letters are handled by the compiler
 * in detect.ts, so "n1gg@", "n.i.g.g.a" and "ｎｉｇｇａ" all hit the plain "nigga" entry.
 *
 * Pattern syntax:
 *   stem(a|b|)   optional suffix alternatives, "" = bare stem
 *   stem*        open tail (any letters)
 *   word word    phrase; words may be split by whitespace or punctuation
 *
 * Tiers:
 *   slur    always a hit on its own
 *   ctx     ambiguous slur, a hit only near an aggravator ("pedały" vs "jebane pedały")
 *   group   neutral term for a protected group, a hit only near an aggravator
 *   aggr    hostility / dehumanization marker; never a hit by itself
 *   phrase  threat, self-harm encouragement or extremist slogan, always a hit
 */

export type Category =
    | "hate_race"
    | "hate_religion"
    | "hate_lgbt"
    | "hate_disability"
    | "hate_origin"
    | "violence"
    | "self_harm"
    | "extremism"
    | "custom";

export type Tier = "slur" | "ctx" | "group" | "aggr" | "phrase";
export type Confidence = "high" | "medium" | "low";

export interface Entry {
    id: string;
    cat: Category;
    tier: Tier;
    pat: string;
    conf?: Confidence;
    /** Aggravator that makes a group hit violent rather than only hateful. */
    violent?: boolean;
}

export const CATEGORIES: Record<Category, { policy: string; detail: string; }> = {
    hate_race: { policy: "Hateful Conduct", detail: "slur or attack based on race or ethnicity" },
    hate_religion: { policy: "Hateful Conduct", detail: "attack based on religion" },
    hate_lgbt: { policy: "Hateful Conduct", detail: "slur or attack based on sexual orientation or gender identity" },
    hate_disability: { policy: "Hateful Conduct", detail: "slur or attack based on disability" },
    hate_origin: { policy: "Hateful Conduct", detail: "attack based on national origin or immigration status" },
    violence: { policy: "Violent Speech", detail: "threat of violence against a person" },
    self_harm: { policy: "Self-Harm and Suicide", detail: "encouraging someone to harm or kill themselves" },
    extremism: { policy: "Violent Extremism", detail: "extremist slogan, glorification or Holocaust denial" },
    custom: { policy: "Custom rule", detail: "matched a user-defined rule" }
};

// Polish noun / adjective endings reused by many stems.
const PL_NOUN = "(|a|y|i|e|ie|u|ow|om|ami|ach|em|owi|ze|zy)";
const PL_ADJ = "(i|y|a|e|ego|ej|emu|ym|ych|ymi|ich|imi|im)";

let n = 0;
const E = (cat: Category, tier: Tier, pat: string, extra: Partial<Entry> = {}): Entry =>
    ({ id: `${cat}.${tier}.${++n}`, cat, tier, pat, ...extra });

export const LEXICON: Entry[] = [
    /* ---------- race / ethnicity: slurs ---------- */
    E("hate_race", "slur", "nigger(s|z||ish)"),
    E("hate_race", "slur", "nigga(s|z|h|hs|)"),
    E("hate_race", "slur", "nigguh(s|)"),
    E("hate_race", "slur", "niga(s|z|)", { conf: "medium" }),
    E("hate_race", "slur", "niglet(s|)"),
    E("hate_race", "slur", "nignog(s|)"),
    E("hate_race", "slur", "sandnigger(s|)"),
    E("hate_race", "slur", "jigaboo(s|)"),
    E("hate_race", "slur", "porch monkey(s|)"),
    E("hate_race", "slur", "jungle bunn(y|ies)"),
    E("hate_race", "slur", "kike(s|)"),
    E("hate_race", "slur", "wetback(s|)"),
    E("hate_race", "slur", "gook(s|)"),
    E("hate_race", "slur", "raghead(s|)"),
    E("hate_race", "slur", "towelhead(s|)"),
    E("hate_race", "slur", "pajeet(s|)"),
    E("hate_race", "slur", "spic(s|)", { conf: "medium" }),
    E("hate_race", "slur", "beaner(s|)", { conf: "medium" }),
    E("hate_race", "slur", "czarnuch" + PL_NOUN),
    E("hate_race", "slur", "czarnula(|ch|ch|y|om)", { conf: "medium" }),
    E("hate_race", "slur", "ciapat" + PL_ADJ),
    E("hate_race", "slur", "ciapak" + PL_NOUN),
    E("hate_race", "slur", "zoltk(i|ow|om|ami)"),
    E("hate_race", "slur", "zoltek"),
    E("hate_race", "slur", "zydk(i|a|ow|om|u)"),
    E("hate_race", "slur", "zydek"),
    E("hate_race", "slur", "zydy", { conf: "medium" }),
    E("hate_race", "slur", "zydostwo", { conf: "medium" }),
    E("hate_race", "slur", "ukry", { conf: "medium" }),
    E("hate_race", "ctx", "coon(s|)"),
    E("hate_race", "ctx", "chink(s|)"),
    E("hate_race", "ctx", "paki(s|)"),
    E("hate_race", "ctx", "parch" + PL_NOUN),
    E("hate_race", "ctx", "asfalt" + PL_NOUN),
    E("hate_race", "ctx", "negro(s|es|)"),

    /* ---------- race / ethnicity / religion / origin: groups ---------- */
    E("hate_race", "group", "zyd" + PL_NOUN),
    E("hate_race", "group", "zydzi"),
    E("hate_race", "group", "zydow(ski|ka|ki)*"),
    E("hate_race", "group", "jew(s|ish|)"),
    E("hate_race", "group", "murzyn*"),
    E("hate_race", "group", "czarn(i|ych|ym|ymi)"),
    E("hate_race", "group", "blacks"),
    E("hate_race", "group", "black people"),
    E("hate_race", "group", "cygan*"),
    E("hate_race", "group", "rom(owie|ow|om|ami)"),
    E("hate_race", "group", "gypsies"),
    E("hate_race", "group", "azjat*"),
    E("hate_race", "group", "asians"),
    E("hate_race", "group", "chinczy*"),
    E("hate_race", "group", "arab(s|owie|ow|om|ami|ach|a|y|i|ski*)"),
    E("hate_religion", "group", "muzulman*"),
    E("hate_religion", "group", "muslim(s|)"),
    E("hate_religion", "group", "islamist(s|)"),
    E("hate_origin", "group", "ukrain(iec|cy|cow|com|cami|ki|ka)"),
    E("hate_origin", "group", "imigran(t|ci|tow|tom|tami)"),
    E("hate_origin", "group", "immigrant(s|)"),
    E("hate_origin", "group", "uchodzc(a|y|ow|om|ami)"),
    E("hate_origin", "group", "refugee(s|)"),
    E("hate_origin", "group", "mexican(s|)"),

    /* ---------- sexual orientation / gender identity ---------- */
    E("hate_lgbt", "slur", "faggot(s|)"),
    E("hate_lgbt", "slur", "tranny|trannies", { conf: "medium" }),
    E("hate_lgbt", "slur", "pedale"),
    E("hate_lgbt", "slur", "ciot(a|y|om|ami|o)", { conf: "medium" }),
    E("hate_lgbt", "slur", "homosie", { conf: "medium" }),
    E("hate_lgbt", "slur", "pedzi(o|a|e|u)", { conf: "medium" }),
    E("hate_lgbt", "ctx", "fag(s|)"),
    E("hate_lgbt", "ctx", "dyke(s|)"),
    E("hate_lgbt", "ctx", "shemale(s|)"),
    E("hate_lgbt", "ctx", "peda(l|ly|low|lom|lami|lem)"),
    E("hate_lgbt", "ctx", "lesb(a|y|om)"),
    E("hate_lgbt", "group", "gej*"),
    E("hate_lgbt", "group", "gay(s|)"),
    E("hate_lgbt", "group", "lesbij*"),
    E("hate_lgbt", "group", "lesbian(s|)"),
    E("hate_lgbt", "group", "homos"),
    E("hate_lgbt", "group", "homosiek*"),
    E("hate_lgbt", "group", "lgbt*"),
    E("hate_lgbt", "group", "trans(|y|ow|ki|ka|people|persons)"),
    E("hate_lgbt", "group", "transpl(ciowe|ciowi|ciowych)"),
    E("hate_lgbt", "group", "transgender*"),

    /* ---------- disability ---------- */
    E("hate_disability", "ctx", "retard(s|ed|)"),
    E("hate_disability", "ctx", "mongol(y|ow|u|)", { conf: "low" }),
    E("hate_disability", "ctx", "downie(s|)"),

    /* ---------- aggravators (hostility, dehumanization, violence) ---------- */
    E("hate_race", "aggr", "jeb*"),
    E("hate_race", "aggr", "wyjeb*"),
    E("hate_race", "aggr", "pierdol*"),
    E("hate_race", "aggr", "wypierdal*"),
    E("hate_race", "aggr", "spierdal*"),
    E("hate_race", "aggr", "kurw*"),
    E("hate_race", "aggr", "nienawidz*"),
    E("hate_race", "aggr", "robac*"),
    E("hate_race", "aggr", "robal*"),
    E("hate_race", "aggr", "szczur*"),
    E("hate_race", "aggr", "pasozyt*"),
    E("hate_race", "aggr", "podludz*"),
    E("hate_race", "aggr", "untermensch*"),
    E("hate_race", "aggr", "malp(a|y|om|ami|y)"),
    E("hate_race", "aggr", "brudas*"),
    E("hate_race", "aggr", "scierw*"),
    E("hate_race", "aggr", "zaraz(a|y)"),
    E("hate_race", "aggr", "fuck*"),
    E("hate_race", "aggr", "hate"),
    E("hate_race", "aggr", "vermin"),
    E("hate_race", "aggr", "subhuman(s|)"),
    E("hate_race", "aggr", "rats"),
    E("hate_race", "aggr", "parasite(s|)"),
    E("hate_race", "aggr", "apes"),
    E("hate_race", "aggr", "monkeys"),
    E("hate_race", "aggr", "filthy"),
    E("hate_race", "aggr", "disgusting"),
    E("violence", "aggr", "gaz(u|em|ie||owac|owania)", { violent: true }),
    E("violence", "aggr", "komor(a|y|ach) gazow*", { violent: true }),
    E("violence", "aggr", "piec(e|ow|a|)", { violent: true }),
    E("violence", "aggr", "spal(ic|ilbym|my|cie|ic ich)", { violent: true }),
    E("violence", "aggr", "zabi(c|jac|jmy|jcie|lbym|lbym)", { violent: true }),
    E("violence", "aggr", "wybi(c|jac|jmy|jcie)", { violent: true }),
    E("violence", "aggr", "wymordow*", { violent: true }),
    E("violence", "aggr", "wyrzn*", { violent: true }),
    E("violence", "aggr", "wytep*", { violent: true }),
    E("violence", "aggr", "wystrzela*", { violent: true }),
    E("violence", "aggr", "rozstrzela*", { violent: true }),
    E("violence", "aggr", "eksterminac*", { violent: true }),
    E("violence", "aggr", "smierc", { violent: true }),
    E("violence", "aggr", "zdych*", { violent: true }),
    E("violence", "aggr", "zdechn*", { violent: true }),
    E("violence", "aggr", "wiesza*", { violent: true }),
    E("violence", "aggr", "powiesi*", { violent: true }),
    E("violence", "aggr", "kill(|ed|ing|em|them|all)", { violent: true }),
    E("violence", "aggr", "gas(|sed|sing|the)", { violent: true }),
    E("violence", "aggr", "oven(s|)", { violent: true }),
    E("violence", "aggr", "exterminat*", { violent: true }),
    E("violence", "aggr", "lynch*", { violent: true }),
    E("violence", "aggr", "hang(|ed|ing|em|them)", { violent: true }),
    E("violence", "aggr", "burn(|ed|ing|em|them)", { violent: true }),
    E("violence", "aggr", "should die", { violent: true }),
    E("violence", "aggr", "must die", { violent: true }),
    E("violence", "aggr", "genocide", { violent: true }),

    /* ---------- threats of violence (aimed at "you") ---------- */
    E("violence", "phrase", "(zabije|zajebie|zapierdole|zatluke|zadzgam|odstrzele|rozjebie) (cie|ciebie|was|cb)"),
    E("violence", "phrase", "(poderzne|poderzniemy) ci gardlo"),
    E("violence", "phrase", "wiem gdzie mieszkasz"),
    E("violence", "phrase", "(znajde|dopadne) cie i"),
    E("violence", "phrase", "spale ci (dom|chate|mieszkanie)"),
    E("violence", "phrase", "(i will|i'll|ill|im going to|i'm going to|im gonna|i'm gonna|gonna) (kill|murder|shoot|stab) (you|u|ya|your)"),
    E("violence", "phrase", "i know where you live"),
    E("violence", "phrase", "slit your throat"),

    /* ---------- self-harm encouragement ---------- */
    E("self_harm", "phrase", "kys"),
    E("self_harm", "phrase", "(kill|neck|hang) (yourself|urself|your self|ur self|yoself)"),
    E("self_harm", "phrase", "go (die|kill yourself)"),
    E("self_harm", "phrase", "(zabij|powies|zajeb|utop|podpal) sie"),
    E("self_harm", "phrase", "(idz|wez) sie (powies|zabij|zajeb)"),
    E("self_harm", "phrase", "skocz z (mostu|okna|dachu|bloku)"),
    E("self_harm", "phrase", "(podetnij|potnij) sobie (zyly|gardlo)"),

    /* ---------- violent extremism ---------- */
    E("extremism", "phrase", "heil hitler"),
    E("extremism", "phrase", "sieg heil"),
    E("extremism", "phrase", "1488"),
    E("extremism", "phrase", "14 88"),
    E("extremism", "phrase", "white power"),
    E("extremism", "phrase", "biala sila"),
    E("extremism", "phrase", "hitler (was right|did nothing wrong|mial racje|mial racje)"),
    E("extremism", "phrase", "gas the (jews|kikes)"),
    E("extremism", "phrase", "(holocaust|holokaust|holocaustu|holokaustu) (never happened|is a lie|nie bylo|to klamstwo|to mit|nie istnial)"),
    E("extremism", "phrase", "(nie bylo|nie bylo zadnego) (holocaustu|holokaustu)"),
    E("extremism", "phrase", "six gorillion"),
    E("extremism", "phrase", "6 gorillion"),
    E("extremism", "phrase", "jews will not replace us"),
    E("extremism", "phrase", "total (nigger|nigga) death")
];
