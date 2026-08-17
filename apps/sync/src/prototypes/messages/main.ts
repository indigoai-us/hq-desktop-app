import { mount } from 'svelte';
import '../../styles/design-system.css';
import '../../desktop-alt/v4/tokens.css';
import MessagesPrototype from './MessagesPrototype.svelte';

const target = document.getElementById('messages-prototype');
if (!target) throw new Error('Missing messages prototype mount target');

mount(MessagesPrototype, { target });
