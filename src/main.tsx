import { render } from 'solid-js/web';
import App from './App';
import './styles/tokens.css';
import './styles/typography.css';
import './styles/layout.css';

render(() => <App initialArticle={new URLSearchParams(location.search).get('article') ?? undefined} />, document.getElementById('root')!);
