// Separate entry: the clickdummy never mounts App, its graph adapter or live API.
import '@fontsource-variable/archivo/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/400-italic.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '../app.css';
import { mount } from 'svelte';
import ReviewBoardPrototype from './ReviewBoardPrototype.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Review board prototype: #app host element is missing');
mount(ReviewBoardPrototype, { target });
