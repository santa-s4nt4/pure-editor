import { render } from 'solid-js/web';
import App from './App';
import ArticleWindow from './components/ArticleWindow';
import './styles/tokens.css';
import './styles/typography.css';
import './styles/layout.css';

render(() => new URLSearchParams(location.search).has('article') ? <ArticleWindow /> : <App />, document.getElementById('root')!);
