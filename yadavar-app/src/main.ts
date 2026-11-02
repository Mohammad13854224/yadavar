import '@fontsource-variable/vazirmatn'
import './lib/fonts'
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { selectApi } from './lib/data/api'
import { app } from './lib/store.svelte'
import './lib/back'

selectApi()
  .catch(() => undefined) // if the on-device engine cannot start, init() below shows the "server unreachable" bar
  .then(() => app.init())
  .then(() => {
    mount(App, { target: document.getElementById('app')! })
  })
