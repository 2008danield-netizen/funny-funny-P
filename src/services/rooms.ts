/**
 * What a room is FOR, as far as the electrical code is concerned.
 *
 * The NEC's requirements are almost all conditional on the kind of room: a
 * bathroom needs GFCI and its own 20 A circuit, a kitchen needs two, a bedroom
 * needs AFCI and a smoke alarm, a hallway needs a switched light but no
 * receptacles under the six-foot rule. So before anything can be laid out, each
 * room has to be classified.
 *
 * It is classified BY ITS NAME, which is a decision worth defending. The
 * alternative is to infer it from the furniture, which the advisor already does
 * — but a house traced from a plan has no furniture in it at all, and that is
 * exactly the case this exists for. The name is what the user typed, it is what
 * appears on the drawing, and if they call it a kitchen then it is a kitchen.
 */

export type RoomPurpose =
  | 'kitchen'
  | 'bathroom'
  | 'bedroom'
  | 'living'
  | 'dining'
  | 'laundry'
  | 'hall'
  | 'stairs'
  | 'garage'
  | 'store'
  | 'outdoor'
  | 'other';

/** Words that name each kind of room, longest and most specific first. */
const NAMES: ReadonlyArray<{ purpose: RoomPurpose; words: readonly string[] }> = [
  { purpose: 'bathroom', words: ['bathroom', 'shower room', 'ensuite', 'en-suite', 'wc', 'toilet', 'powder', 'cloakroom', 'bath'] },
  { purpose: 'kitchen', words: ['kitchen', 'kitchenette', 'pantry', 'scullery'] },
  { purpose: 'laundry', words: ['laundry', 'utility', 'washer', 'mud room', 'mudroom'] },
  { purpose: 'bedroom', words: ['bedroom', 'bed room', 'nursery', 'guest room', 'primary suite', 'master'] },
  { purpose: 'dining', words: ['dining', 'breakfast'] },
  { purpose: 'living', words: ['living', 'lounge', 'sitting', 'family', 'parlor', 'parlour', 'den', 'study', 'office', 'library', 'sunroom', 'rec room', 'recreation', 'great room'] },
  { purpose: 'stairs', words: ['stair', 'landing'] },
  { purpose: 'hall', words: ['hall', 'corridor', 'passage', 'entry', 'foyer', 'vestibule'] },
  { purpose: 'garage', words: ['garage', 'carport', 'workshop'] },
  { purpose: 'store', words: ['closet', 'storage', 'store', 'wardrobe', 'cupboard', 'plant'] },
  { purpose: 'outdoor', words: ['porch', 'deck', 'patio', 'balcony', 'terrace', 'veranda'] },
];

/**
 * Which kind of room a name describes.
 *
 * The match is anchored to the START of a word, and deliberately not to its
 * end: "bath" has to find "Bathroom" and "stair" has to find "Stairs", so a
 * trailing plural or suffix is allowed. What is not allowed is a match in the
 * middle of a word — without that anchor "Upstairs Hall" contains "stair" and
 * comes out as a stairway, which is exactly the kind of quiet mistake that puts
 * a room on the wrong side of the six-foot rule.
 */
export function roomPurpose(name: string): RoomPurpose {
  const lower = name.toLowerCase();
  for (const entry of NAMES) {
    if (entry.words.some((word) => startsAWord(lower, word))) return entry.purpose;
  }
  return 'other';
}

/** Whether `word` appears in `text` at the start of a word. */
function startsAWord(text: string, word: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(word, from);
    if (at < 0) return false;
    const before = at === 0 ? ' ' : text[at - 1]!;
    if (!/[a-z0-9]/.test(before)) return true;
    from = at + 1;
  }
}

/**
 * Whether the NEC counts this as a habitable room.
 *
 * The distinction runs through the whole of Article 210: habitable rooms get
 * the six-foot receptacle rule and a switched light; halls, closets and garages
 * do not — they have their own, lighter, requirements. Bathrooms and kitchens
 * are not "habitable" in the code's sense but have stricter rules of their own,
 * so they are handled separately everywhere rather than folded in here.
 */
export function isHabitable(purpose: RoomPurpose): boolean {
  return purpose === 'bedroom' || purpose === 'living' || purpose === 'dining' || purpose === 'other';
}

/** Whether NEC 210.8(A) requires ground-fault protection in this room. */
export function needsGfci(purpose: RoomPurpose): boolean {
  return (
    purpose === 'bathroom' ||
    purpose === 'kitchen' ||
    purpose === 'laundry' ||
    purpose === 'garage' ||
    purpose === 'outdoor'
  );
}

/**
 * Whether NEC 210.12(A) requires arc-fault protection.
 *
 * The list in the code is long and reads like an inventory of rooms people sit
 * in. The short version is: everywhere in a dwelling except bathrooms, garages
 * and outdoors — which are the places that get GFCI instead.
 */
export function needsAfci(purpose: RoomPurpose): boolean {
  return purpose !== 'bathroom' && purpose !== 'garage' && purpose !== 'outdoor';
}

/** A human name for a purpose, for labels and schedules. */
export function purposeLabel(purpose: RoomPurpose): string {
  const labels: Record<RoomPurpose, string> = {
    kitchen: 'Kitchen',
    bathroom: 'Bathroom',
    bedroom: 'Bedroom',
    living: 'Living space',
    dining: 'Dining',
    laundry: 'Laundry',
    hall: 'Hall',
    stairs: 'Stairway',
    garage: 'Garage',
    store: 'Storage',
    outdoor: 'Outdoors',
    other: 'Room',
  };
  return labels[purpose];
}
