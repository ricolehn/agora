// The plan of an event (duty roster and order of service) and its sharing (owner: the plan / sharing port). The event
// detail dialog shows <EventPlan event={...} /> and the share button calls openEventShare(); a live update of the
// events reloads the open plan with refreshProgram().
export { EventPlan } from './EventPlan';
export { refreshProgram } from './program';
export { openEventShare } from '../share/share';
