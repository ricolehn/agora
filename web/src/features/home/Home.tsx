import { For } from 'solid-js';
import { Dynamic } from '@solidjs/web';
import { homeCards } from '../../app/registry';
import './home.css';

/** The start page: the parts the features registered (app/registry.ts registerHomeCard), in their order. */
export function Home() {
  return (
    <div class="home-page">
      <For each={homeCards}>{card => <Dynamic component={card.component} />}</For>
    </div>
  );
}
