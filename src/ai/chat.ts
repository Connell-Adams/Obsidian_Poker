import type { Rng } from '../engine/rng';
import type { BotProfile } from './profiles';

export type ChatTrigger =
  | 'big_win'
  | 'big_loss'
  | 'bad_beat'
  | 'gave_bad_beat'
  | 'bluff_shown'
  | 'all_in'
  | 'knockout'
  | 'eliminated'
  | 'nice_hand'
  | 'long_tank';

const LINES: Record<ChatTrigger, readonly string[]> = {
  big_win: ['Ship it! 🤑', 'That one felt good.', 'Thanks for the chips 😎', 'Stacking up.', 'I will take that.', 'Running hot tonight 🔥'],
  big_loss: ['Ouch.', 'Well played.', 'That hurt.', 'Back to the grind 😤', 'Okay, okay.', 'Could not fold that.'],
  bad_beat: ['Are you kidding me?! 😡', 'Unbelievable river.', 'Every single time…', 'One outer. Of course.', 'I need a walk.', 'How do you call that?!'],
  gave_bad_beat: ['Sorry, got there 😅', 'Lucky river, I know.', 'I will take the suckout.', 'My bad 🙈', 'Poker is a cruel game.'],
  bluff_shown: ['Nice bluff.', 'You had that?! 😂', 'Got me.', 'Sneaky.', 'I knew it!'],
  all_in: ['All in, your move.', 'Let us gamble 🎲', 'Time to find out.', 'No more small pots.', 'Good luck.'],
  knockout: ['Good game.', 'Thanks for playing.', 'One down.', 'gg 🤝'],
  eliminated: ['gg all.', 'Well, that is me done.', 'Good luck everyone 👋', 'See you next time.'],
  nice_hand: ['nh', 'Nice hand.', 'Well played 👏', 'Good call.'],
  long_tank: ['Tough spot.', 'Take your time.', 'Clock?', 'Thinking…'],
};

/** How talkative an archetype is. Nits stay quiet, maniacs rarely shut up. */
function chattiness(profile: BotProfile): number {
  switch (profile.archetype) {
    case 'maniac':
    case 'aggressive_bluffer':
      return 0.55;
    case 'recreational':
      return 0.45;
    case 'calling_station':
      return 0.3;
    case 'nit':
    case 'gto_reg':
      return 0.1;
    default:
      return 0.2;
  }
}

/** Maybe returns a short reaction. The table controller also rate-limits the whole table. */
export function chatReaction(trigger: ChatTrigger, profile: BotProfile, tilt: number, rng: Rng): string | null {
  const urgency = trigger === 'bad_beat' ? 2 : trigger === 'all_in' || trigger === 'long_tank' ? 0.4 : 1;
  if (rng.next() > chattiness(profile) * urgency * (1 + tilt)) return null;
  const pool = LINES[trigger];
  return pool[rng.int(pool.length)];
}
