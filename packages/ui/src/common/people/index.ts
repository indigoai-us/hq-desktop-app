// OWNER-R5 shared people display. Stable import path for other surfaces:
//   import { PersonName, resolvePerson, peopleFor, loadPeople } from "../common/people/index.js";
export * from "./people.js";
export { peopleFor, loadPeople, resetPeopleRosters, setActivePeopleCompany, activePeople } from "./people-roster.svelte.js";
export { default as PersonName } from "./PersonName.svelte";
