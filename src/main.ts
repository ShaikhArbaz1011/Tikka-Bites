import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/billing.css';
import './styles/print.css';

import { $ } from './ui/dom';
import { renderNav } from './ui/components/nav';
import { startRouter } from './router';

const setActive = renderNav($('#nav'));
startRouter($('#view'), setActive);
