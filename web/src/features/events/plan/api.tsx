// The plan of an event (duty roster and order of service) and its sharing (owner: the plan / sharing port).
// Stubs until ported. The event detail dialog shows <EventPlan event={...} /> and the share button calls
// openEventShare(); a change of the events reloads the plan with refreshProgram().
export function EventPlan(_props: { event: any }) {
  return null;
}
export async function refreshProgram(): Promise<void> {}
export function openEventShare(_eventId: string): void {}
