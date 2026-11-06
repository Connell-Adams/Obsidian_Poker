import type { Rng } from '../engine/rng';
import type { StatCounters } from '../stats/counters';
import { type ChatTrigger, chatReaction } from './chat';
import { type Decision, decide } from './decision';
import { type EmotionalState, type HandOutcomeForBot, neutralEmotions, updateEmotions } from './emotions';
import type { BotProfile } from './profiles';
import { type ThinkingTime, thinkingTime } from './timing';
import type { PublicHandView } from './view';

/** One AI opponent: fixed personality plus a mood that changes with results. */
export class BotBrain {
  readonly profile: BotProfile;
  mood: EmotionalState;
  private readonly rng: Rng;

  constructor(profile: BotProfile, rng: Rng, mood?: EmotionalState) {
    this.profile = profile;
    this.rng = rng;
    this.mood = mood ?? neutralEmotions();
  }

  decide(view: PublicHandView, countersOf: (id: string) => StatCounters | undefined, fast = false): Decision {
    return decide({ profile: this.profile, mood: this.mood, view, countersOf, rng: this.rng, fast });
  }

  thinkTime(decision: Decision, view: PublicHandView): ThinkingTime {
    return thinkingTime(decision, view, this.profile, this.mood, this.rng);
  }

  observeHand(outcome: HandOutcomeForBot): void {
    this.mood = updateEmotions(this.mood, outcome, this.profile.attrs);
  }

  say(trigger: ChatTrigger): string | null {
    return chatReaction(trigger, this.profile, this.mood.tilt, this.rng);
  }
}
