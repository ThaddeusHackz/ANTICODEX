import { findOne, insert, update } from './store.js';

function rowId(userId) {
  return `skills_${String(userId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)}`;
}

export async function getSkillSettings(userId) {
  if (!userId) return {};
  const row = await findOne('skill_settings', (item) => item.user_id === userId);
  return row?.states && typeof row.states === 'object' ? { ...row.states } : {};
}

export async function setSkillEnabled(userId, name, enabled) {
  if (!userId) throw new Error('user required');
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 64) throw new Error('valid skill name required');
  const existing = await findOne('skill_settings', (item) => item.user_id === userId);
  const states = { ...(existing?.states || {}), [cleanName]: enabled === true };
  const row = { id: existing?.id || rowId(userId), user_id: userId, states, updated_at: new Date().toISOString() };
  if (existing) await update('skill_settings', (item) => item.id === existing.id && item.user_id === userId, row);
  else await insert('skill_settings', { ...row, created_at: new Date().toISOString() });
  return states;
}

export function applySkillSettings(skills, states = {}) {
  return (skills || []).map((skill) => ({
    ...skill,
    enabled: Object.prototype.hasOwnProperty.call(states, skill.name) ? states[skill.name] === true : true
  }));
}
