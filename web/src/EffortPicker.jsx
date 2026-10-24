import React from 'react';
import { useApp } from './lib/state.jsx';

// How hard the model should think, next to which model is thinking.
//
// "The answers are slow" is mostly a question of deliberation that nobody could
// turn down: the same prompt with `fast` answers in a second, with `max` it can
// think for twenty. Three buttons make that a decision instead of a mystery, and
// the choice is per browser (localStorage) so it survives a reload without an
// account.
export const EFFORTS = [
  { id: 'fast', label: 'Fast', title: 'Short answers, no deliberation — 512 tokens, temperature 0.3' },
  { id: 'balanced', label: 'Balanced', title: 'The default — 1200 tokens, low reasoning effort' },
  { id: 'max', label: 'Max', title: 'Long answers, full deliberation — 4096 tokens, high reasoning effort' }
];

export function effortLabel(id) {
  return (EFFORTS.find((e) => e.id === id) || EFFORTS[1]).label;
}

export default function EffortPicker({ compact = false }) {
  const { effort, setEffort } = useApp();
  return (
    <div className={`effort ${compact ? 'compact' : ''}`} role="group" aria-label="How hard the model should think">
      <span className="effort-label" title="Deliberation budget">◎</span>
      {EFFORTS.map((e) => (
        <button
          key={e.id}
          type="button"
          title={e.title}
          aria-pressed={effort === e.id}
          className={`effort-btn${effort === e.id ? ' on' : ''}`}
          onClick={() => setEffort(e.id)}
        >
          {e.label}
        </button>
      ))}
    </div>
  );
}
