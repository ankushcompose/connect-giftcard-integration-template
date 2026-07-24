import {
  Amount,
  BalanceType,
  BaseOptions,
  GiftCardComponent,
  GiftCardOptions,
  PaymentResult,
} from '../providers/definitions';
import { BaseComponentBuilder, DefaultComponent } from './definitions';
import { fieldIds, getErrorCode, getInput, hideError, showError } from './utils';
import inputFieldStyles from '../style/inputField.module.scss';
import I18n from '../i18n';
import { translations } from '../i18n/translations';

// Qantas-hosted sign-in widget bundle (fixed Qantas infrastructure), env-selected.
const QANTAS_WIDGET_SRC: Record<string, string> = {
  stg: 'https://cdn.stg.qantasloyalty.com/appcache/wid-redemptions-button/master/0.0.0/qantas.min.js',
  live: 'https://cdn.qantasloyalty.com/appcache/wid-redemptions-button/master/0.0.0/qantas.min.js',
};

type WidgetConfig = {
  clientId: string;
  clientName: string;
  env: string;
  amount: Amount;
};

interface QantasPaymentActions {
  createQuote: (amount: number, items?: unknown[]) => unknown;
  createFixedQuote: (amount: number, items?: unknown[]) => unknown;
}

interface QantasAuthorizeData {
  memberNumber: number;
  quoteNumber: string;
  currencyAmount: number;
  pointsBurned: number;
}

interface QantasButtonConfig {
  Client: { id: string; name: string };
  payment: (actions: QantasPaymentActions) => unknown;
  onAuthorize?: (data: QantasAuthorizeData) => void;
  onError?: (message: string) => void;
}

interface QantasWidget {
  render: (config: QantasButtonConfig, selector: string) => void;
}

// The bundle attaches its namespace to `window.qantas` and exposes the button as
// `window.qantas.Button` (confirmed against the staging bundle); fall back to a
// bare `window.Button` in case a future bundle exposes it directly.
const readWidget = (): QantasWidget | null => {
  const scope = window as unknown as {
    qantas?: { Button?: QantasWidget };
    Button?: QantasWidget;
  };
  const candidate = scope.qantas?.Button ?? scope.Button;
  return candidate && typeof candidate.render === 'function' ? candidate : null;
};

// English copy for the Qantas method (the connector's i18n set covers gift-card
// codes only; kept inline for this POC).
const COPY = {
  body: 'Qantas Frequent Flyer members can put points towards this order. Sign in with Qantas and choose how many points to use; the rest is paid by card.',
  applied: (points: string, dollars: string, remaining: string) =>
    `${points} Qantas Points applied (${dollars}). ${remaining} still to pay by card.`,
  // Points must always be PARTIAL — a card balance must remain (shown when the
  // member tries to redeem points worth the whole order or more).
  tooMuch:
    'Qantas Points can only cover part of your order. Please choose fewer points so a balance remains to pay by card.',
  unavailableConfig: 'Qantas Points isn’t set up for this store yet.',
  // The bundle/button genuinely failed to load (script error / widget missing).
  unavailableLoad: 'The Qantas Points sign-in couldn’t load. Please refresh and try again.',
  // The sign-in loaded fine but reported a problem mid-flow (distinct from a
  // load failure, and it must NOT wipe points the member already applied).
  widgetError: 'Something went wrong with the Qantas sign-in. Please try again.',
  ariaLabel: 'Use Qantas Points',
};

export class FormBuilder extends BaseComponentBuilder {
  constructor(baseOptions: BaseOptions) {
    super(baseOptions);
  }

  build(config: GiftCardOptions): GiftCardComponent {
    return new FormComponent({
      giftcardOptions: config,
      baseOptions: this.baseOptions,
    });
  }
}

export class FormComponent extends DefaultComponent {
  protected i18n: I18n;
  private widgetConfig?: WidgetConfig;
  // True once the member has a valid points reservation applied, so a later
  // widget error (e.g. the sign-in closing) doesn't wipe it.
  private applied = false;

  constructor(opts: { giftcardOptions: GiftCardOptions; baseOptions: BaseOptions }) {
    super(opts);
    this.i18n = new I18n(translations);
    this.balance = this.balance.bind(this);
    this.submit = this.submit.bind(this);
  }

  // Reads the (hidden) reservation reference the Qantas sign-in populates, and
  // asks the processor to validate it. Unchanged contract: the checkout drives
  // this, and the processor treats the reference as the gift-card "code".
  async balance(): Promise<BalanceType> {
    try {
      const giftCardCode = getInput(fieldIds.code).value.replace(/\s/g, '');
      const requestBody = { code: giftCardCode };
      const fetchBalanceURL = this.baseOptions.processorUrl.endsWith('/')
        ? `${this.baseOptions.processorUrl}balance`
        : `${this.baseOptions.processorUrl}/balance`;
      const response = await fetch(fetchBalanceURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': this.baseOptions.sessionId,
        },
        body: JSON.stringify(requestBody),
      });

      const jsonResponse = await response.json();
      if (!jsonResponse?.status?.state) {
        throw jsonResponse;
      }

      const errorCode = getErrorCode(jsonResponse);
      if (errorCode) {
        const translatedMessage = this.i18n.keyExists(`error${errorCode}`, this.baseOptions.locale)
          ? this.i18n.translate(`error${errorCode}`, this.baseOptions.locale)
          : this.i18n.translate('errorGenericError', this.baseOptions.locale);
        showError(fieldIds.code, translatedMessage);
      } else {
        hideError(fieldIds.code);
      }

      return jsonResponse;
    } catch (err) {
      showError(fieldIds.code, this.i18n.translate('errorGenericError', this.baseOptions.locale));
      this.baseOptions.onError(err);
    }
  }

  async submit(params: { amount?: Amount }): Promise<void> {
    try {
      const giftCardCode = getInput(fieldIds.code).value.replace(/\s/g, '');
      const requestBody = {
        redeemAmount: params.amount,
        code: giftCardCode,
      };
      const requestRedeemURL = this.baseOptions.processorUrl.endsWith('/')
        ? `${this.baseOptions.processorUrl}redeem`
        : `${this.baseOptions.processorUrl}/redeem`;

      const response = await fetch(requestRedeemURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': this.baseOptions.sessionId,
        },
        body: JSON.stringify(requestBody),
      });

      const redeemResult = await response.json();

      if (!response.ok) {
        throw redeemResult;
      }

      const paymentResult: PaymentResult = {
        isSuccess: redeemResult.result,
        paymentReference: redeemResult.paymentReference,
      };

      this.baseOptions.onComplete(paymentResult);
    } catch (err) {
      this.baseOptions.onError(err);
    }
    return;
  }

  mount(selector: string): void {
    document.querySelector(selector).insertAdjacentHTML('afterbegin', this._getField());

    // Load config + the Qantas sign-in button (async; renders once ready).
    void this.initQantas();

    this.giftcardOptions
      ?.onGiftCardReady?.()
      .then()
      .catch((err) => {
        this.baseOptions.onError(err);
        throw err;
      });
  }

  // Fetch the PUBLIC widget config (Qantas id/name/env + cart payable) from the
  // processor, load the Qantas bundle, and render the sign-in button. Degrades to
  // an inline message rather than a broken control.
  private async initQantas(): Promise<void> {
    let cfg: WidgetConfig | null = null;
    try {
      const configURL = this.baseOptions.processorUrl.endsWith('/')
        ? `${this.baseOptions.processorUrl}config`
        : `${this.baseOptions.processorUrl}/config`;
      const res = await fetch(configURL, {
        method: 'GET',
        headers: { 'X-Session-Id': this.baseOptions.sessionId },
      });
      if (res.ok) {
        cfg = (await res.json()) as WidgetConfig;
      }
    } catch {
      cfg = null;
    }

    if (!cfg || !cfg.clientId || !cfg.clientName) {
      this._showUnavailable(COPY.unavailableConfig);
      return;
    }
    const conf: WidgetConfig = cfg;
    this.widgetConfig = conf;

    try {
      await this._loadScript(QANTAS_WIDGET_SRC[conf.env] ?? QANTAS_WIDGET_SRC.stg);
    } catch {
      this._showUnavailable(COPY.unavailableLoad);
      return;
    }

    const widget = readWidget();
    if (!widget) {
      this._showUnavailable(COPY.unavailableLoad);
      return;
    }

    try {
      widget.render(
        {
          Client: { id: conf.clientId, name: conf.clientName },
          // Reserve against the amount left to pay (dollars); the member picks
          // how much within that cap.
          payment: (actions: QantasPaymentActions) =>
            actions.createQuote(conf.amount.centAmount / 100, []),
          onAuthorize: (data: QantasAuthorizeData) => this._onAuthorize(data),
          onError: () => this._onWidgetError(),
        },
        '#qantas-points-button',
      );
    } catch {
      this._showUnavailable(COPY.unavailableLoad);
    }
  }

  // Member reserved a points quote: encode it as the gift-card "code" the
  // processor's balance/redeem expect (QF:member:quote:cents:currency), reflect
  // the applied state, and tell the checkout a value is present so its Apply/Pay
  // controls enable. The actual burn (server-side, fail-closed) happens on redeem.
  private _onAuthorize(data: QantasAuthorizeData): void {
    const currency = this.widgetConfig?.amount.currencyCode ?? '';
    const payableCents = this.widgetConfig?.amount.centAmount ?? 0;
    const cents = Math.round(data.currencyAmount * 100);
    const locale = this.baseOptions.locale || 'en-AU';
    const money = (dollars: number) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency: currency || 'AUD' }).format(dollars);

    // PARTIAL-ONLY RULE: Qantas Points can never cover the whole order — a card
    // balance must always remain. If the member redeemed points worth the full
    // total (or more), reject it (fail-closed: nothing applied) and prompt them
    // to choose fewer. Reserving below the total also avoids over-burning points.
    if (cents <= 0 || cents >= payableCents) {
      this.applied = false;
      getInput(fieldIds.code).value = '';
      const un = document.getElementById('qantas-points-unavailable');
      if (un) {
        un.textContent = COPY.tooMuch;
        un.removeAttribute('hidden');
      }
      const appliedEl = document.getElementById('qantas-points-applied');
      if (appliedEl) appliedEl.setAttribute('hidden', '');
      void this.giftcardOptions?.onValueChange?.(false);
      return;
    }

    const code = `QF:${data.memberNumber}:${data.quoteNumber}:${cents}:${currency}`;
    getInput(fieldIds.code).value = code;
    hideError(fieldIds.code);

    // Clear any prior "choose fewer points" message now that the pick is valid.
    const un = document.getElementById('qantas-points-unavailable');
    if (un) un.setAttribute('hidden', '');

    const points = new Intl.NumberFormat(locale).format(Math.max(0, Math.round(data.pointsBurned)));
    const remaining = money((payableCents - cents) / 100);

    const applied = document.getElementById('qantas-points-applied');
    if (applied) {
      applied.textContent = COPY.applied(points, money(data.currencyAmount), remaining);
      applied.removeAttribute('hidden');
    }

    this.applied = true;
    void this.giftcardOptions?.onValueChange?.(true);
  }

  // The Qantas widget reported an error AFTER it loaded. If the member already
  // has a valid reservation applied, keep it (a benign close/error must not wipe
  // it); otherwise surface a truthful "try again" message (not "couldn't load").
  private _onWidgetError(): void {
    if (this.applied) return;
    const un = document.getElementById('qantas-points-unavailable');
    if (un) {
      un.textContent = COPY.widgetError;
      un.removeAttribute('hidden');
    }
    void this.giftcardOptions?.onValueChange?.(false);
  }

  private _loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Qantas widget failed to load'));
      document.head.appendChild(script);
    });
  }

  private _showUnavailable(message: string): void {
    const el = document.getElementById('qantas-points-unavailable');
    if (el) {
      el.textContent = message;
      el.removeAttribute('hidden');
    }
    void this.giftcardOptions?.onValueChange?.(false);
  }

  private _getField() {
    return `
        <div class="${inputFieldStyles.wrapper}">
          <div class="${inputFieldStyles.paymentForm}">
            <p>${COPY.body}</p>
            <div id="qantas-points-button" aria-label="${COPY.ariaLabel}"></div>
            <p id="qantas-points-applied" role="status" aria-live="polite" hidden></p>
            <p id="qantas-points-unavailable" role="status" aria-live="polite" hidden></p>
            <input type="hidden" id="giftcard-code" name="giftCardCode" value="" />
            <div
              id="giftcard-code-error"
              class="${inputFieldStyles.errorField}"
              role="alert"
              aria-live="polite"
              aria-hidden="true"
            ></div>
          </div>
        </div>
      `;
  }
}
