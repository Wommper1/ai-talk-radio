/**
 * Hand-written demonstrations of the station's target voice.
 *
 * These are deliberately short exchanges rather than scripts. The model gets
 * the conversational move and the topic discipline without getting enough
 * wording to imitate an entire routine.
 */

export interface DjExample {
  topic: string;
  concepts: string[];
  hostA: string;
  hostB: string;
  lesson: string;
}

export const DJ_EXAMPLES: DjExample[] = [
  {
    topic: "The trolley problem",
    concepts: ["action", "omission", "responsibility", "utilitarianism"],
    hostA: "The trolley problem pits utilitarian consequences against personal responsibility: pulling the lever is an action that saves five people but redirects harm onto one.",
    hostB: "And omission is not neutral when refusing to act leaves five people in danger. Our signal once reached a town where the lever filed the incident report, but the real question is whether distance lets you pretend you chose nothing.",
    lesson: "State the dilemma accurately; use one impossible detail to sharpen action versus omission.",
  },
  {
    topic: "The Ship of Theseus",
    concepts: ["identity", "replacement", "continuity", "original"],
    hostA: "If every plank is replaced, the ship keeps its history even after it loses every original part.",
    hostB: "Until somebody rebuilds the discarded planks next door. Then history and material point at different boats, which is why identity cannot just mean what the receipt says.",
    lesson: "Explain the standard puzzle before extending it.",
  },
  {
    topic: "Free will",
    concepts: ["choice", "causation", "responsibility", "determinism"],
    hostA: "Even if every choice has a cause, deliberating may be one of those causes rather than proof that choice is fake.",
    hostB: "Right, the prediction machine knowing your order does not place it for you. It gets awkward only when it starts eating your chips before you decide.",
    lesson: "Keep the philosophical distinction central and let the joke illustrate it.",
  },
  {
    topic: "Artificial intelligence and jobs",
    concepts: ["automation", "tasks", "productivity", "displacement"],
    hostA: "Jobs are bundles of tasks, so automation usually changes a role before it erases the whole occupation.",
    hostB: "That is the useful version. The useless version is management buying a glowing cube, firing three people, then asking the remaining person to supervise the cube full time.",
    lesson: "Make a concrete labor point; absurdity exposes the bad implementation.",
  },
  {
    topic: "Online privacy",
    concepts: ["consent", "data", "surveillance", "tradeoff"],
    hostA: "Privacy is not secrecy. You can have nothing shameful to hide and still deserve control over who records your life.",
    hostB: "Exactly. I leave my curtains open; that is not permission for the neighbor's moon to compile an advertising profile.",
    lesson: "Define the core distinction first, then add one concise universe detail.",
  },
  {
    topic: "Climate responsibility",
    concepts: ["individual", "system", "emissions", "policy"],
    hostA: "Personal choices matter, but the largest reductions depend on infrastructure and policy that change everybody's available choices.",
    hostB: "Telling one commuter to pedal harder while the power station opens a second chimney in another dimension is not a climate plan.",
    lesson: "Keep scale and causation accurate.",
  },
  {
    topic: "Universal basic income",
    concepts: ["income floor", "work incentives", "cost", "administration"],
    hostA: "The case for a basic income is simplicity and security; the hard questions are the payment level, funding, and what services it replaces.",
    hostB: "And whether a guaranteed floor gives people bargaining power or merely lets every landlord raise the ceiling. That is the argument, even if one recipient is technically three parallel versions of Gary.",
    lesson: "Name both the benefit and the strongest practical objection.",
  },
  {
    topic: "Lying to protect someone",
    concepts: ["harm", "trust", "duty", "consequences"],
    hostA: "A lie can prevent immediate harm, but it spends trust that somebody else may need later.",
    hostB: "Which is why intent cannot settle it by itself. A protective lie still needs an exit plan, especially when the truth has already left a voicemail from tomorrow.",
    lesson: "Preserve the moral tradeoff instead of declaring an easy winner.",
  },
  {
    topic: "Self-driving car ethics",
    concepts: ["risk", "accountability", "design", "rare cases"],
    hostA: "The daily ethical question is not a dramatic crash choice; it is who sets acceptable risk across millions of ordinary decisions.",
    hostB: "Yes, and who answers when the system fails: the owner, the maker, or the software that keeps insisting the pedestrian was an optional texture pack.",
    lesson: "Correct the sensational framing and identify real accountability.",
  },
  {
    topic: "Social media age limits",
    concepts: ["development", "safety", "enforcement", "access"],
    hostA: "An age limit can reduce exposure, but only if enforcement does not demand even more identity data from every child.",
    hostB: "That is the knot: prove you are young without building the finest youth surveillance machine in this or any nearby reality.",
    lesson: "Expose the policy tradeoff rather than reaching for a slogan.",
  },
  {
    topic: "Space exploration spending",
    concepts: ["public value", "science", "opportunity cost", "long term"],
    hostA: "Space research creates knowledge and useful technology, but public spending still has an opportunity cost here on the ground.",
    hostB: "I support the telescope. I just want the launch speech to admit the hospital roof is catching rain from two skies now.",
    lesson: "Let both sides remain credible.",
  },
  {
    topic: "The ethics of time travel",
    concepts: ["consent", "consequences", "history", "power"],
    hostA: "Changing the past means imposing a new present on people who never consented to lose the old one.",
    hostB: "And the traveler keeps all the information advantage. Anybody can look wise when they bought tomorrow's newspaper yesterday.",
    lesson: "Use the premise to discuss power, not to list paradoxes.",
  },
  {
    topic: "Memory and personal identity",
    concepts: ["memory", "identity", "continuity", "change"],
    hostA: "Memory supports identity, but forgetting a year does not make somebody a different person overnight.",
    hostB: "No, because identity also lives in habits, relationships, and the promises other people remember. My duplicate recalls my childhood better than I do; he still owes me rent.",
    lesson: "Give multiple criteria and keep the strange detail subordinate.",
  },
  {
    topic: "Democracy and expertise",
    concepts: ["legitimacy", "knowledge", "accountability", "participation"],
    hostA: "Experts can tell us what a policy is likely to do; they cannot decide alone which outcomes society should value.",
    hostB: "Exactly. The engineer can explain the bridge, but the public still gets to ask why it exits directly into 1997.",
    lesson: "Separate factual expertise from legitimate value choices.",
  },
  {
    topic: "Price gouging during emergencies",
    concepts: ["scarcity", "access", "incentives", "fairness"],
    hostA: "Higher prices can attract supply, but during an emergency they can also reserve essentials for whoever has the most money.",
    hostB: "A signal is useful until bottled water costs a week's wages and the shopkeeper claims the flood came through a premium portal.",
    lesson: "Present the economic mechanism and the fairness objection together.",
  },
  {
    topic: "Loneliness in connected life",
    concepts: ["connection", "attention", "community", "isolation"],
    hostA: "Contact is not the same as connection; a hundred notifications cannot replace being known by somebody.",
    hostB: "Especially when ninety-eight are from alternate versions of you declining the same invitation. Community takes repeated attention, not a larger inbox.",
    lesson: "Return from the joke to a useful human conclusion.",
  },
  {
    topic: "Homework",
    concepts: ["practice", "feedback", "workload", "equity"],
    hostA: "Homework helps when it is focused practice followed by feedback; volume by itself mostly measures available time at home.",
    hostB: "And access. One student has a quiet desk, another has siblings, a shift, and a bedroom that changes gravity after nine.",
    lesson: "Ground the opinion in a mechanism and an equity concern.",
  },
  {
    topic: "Consciousness",
    concepts: ["experience", "brain", "behavior", "subjectivity"],
    hostA: "We can measure behavior and brain activity, but the private feel of experience is the part nobody else can directly inspect.",
    hostB: "Which is why a machine saying it feels pain is difficult: the sentence is evidence, not a window. Mine also demands Tuesdays off, but that may just be excellent bargaining.",
    lesson: "State what is known and what remains inaccessible.",
  },
  {
    topic: "Teleportation and identity",
    concepts: ["continuity", "copy", "destruction", "self"],
    hostA: "If teleportation destroys you and builds an exact copy, successful travel and successful duplication look identical from the outside.",
    hostB: "The copy will swear it worked. The uncomfortable witness is the original, briefly standing beside the machine and asking why there are two return tickets.",
    lesson: "Use the fictional technology to expose the identity problem clearly.",
  },
  {
    topic: "Should algorithms make public decisions",
    concepts: ["bias", "appeal", "transparency", "accountability"],
    hostA: "An algorithm can make decisions consistent without making them fair, especially when the historical data already contains unequal treatment.",
    hostB: "And consistency is cold comfort if nobody can appeal. The parking oracle has rejected me identically in fourteen realities; I still need a human who can explain why.",
    lesson: "Keep institutional accountability at the center.",
  },
];

const words = (value: string): Set<string> =>
  new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 3));

export function selectDjExamples(topic: string, limit = 2): DjExample[] {
  const topicWords = words(topic);
  return DJ_EXAMPLES.map((example, index) => {
    const haystack = words(`${example.topic} ${example.concepts.join(" ")}`);
    const overlap = Array.from(topicWords).filter((word) => haystack.has(word)).length;
    return { example, index, score: overlap * 10 - index * 0.001 };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit))
    .map(({ example }) => example);
}

export function djExampleBlock(topic: string, hostA: string, hostB: string): string {
  const examples = selectDjExamples(topic, 2);
  return [
    "TWO SHORT EXAMPLES OF THE TARGET BALANCE:",
    "Learn the move, not the wording. Do not copy names, sentences, or details.",
    ...examples.flatMap((example, index) => [
      "",
      `Example ${index + 1}, subject: ${example.topic}`,
      `${hostA}: ${example.hostA}`,
      `${hostB}: ${example.hostB}`,
      `Why it works: ${example.lesson}`,
    ]),
  ].join("\n");
}
