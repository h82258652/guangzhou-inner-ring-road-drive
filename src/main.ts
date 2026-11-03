import './ui/style.css';
import { App } from './App';

const root = document.getElementById('app')!;
const app = new App(root);
app.start().catch((err) => {
  console.error(err);
  app.showFatal(err as Error);
});
