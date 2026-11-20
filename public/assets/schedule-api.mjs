export const signIn = '/signin-with-chatgpt?return_to=%2F';
export const signOut = '/signout-with-chatgpt?return_to=%2F';

export async function updateSchedule(data) {
  const response = await fetch('/api/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (response.ok) return;
  const body = await response.json().catch(() => null);
  throw new Error(body?.error ?? 'The update couldn’t be saved. Try again.');
}
