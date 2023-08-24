import {
  BehaviorSubject,
  EmptyError,
  filter,
  firstValueFrom,
  fromEvent,
  merge,
  Observable,
  Subject,
  switchMap,
  take,
  takeUntil,
  throwError,
  fromEventPattern,
} from "rxjs";

import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { UserRequestedFallbackAbortReason } from "@bitwarden/common/vault/abstractions/fido2/fido2-client.service.abstraction";
import {
  Fido2UserInterfaceService as Fido2UserInterfaceServiceAbstraction,
  Fido2UserInterfaceSession,
  NewCredentialParams,
  PickCredentialParams,
} from "@bitwarden/common/vault/abstractions/fido2/fido2-user-interface.service.abstraction";

import { BrowserApi } from "../../platform/browser/browser-api";
import { Popout, PopupUtilsService } from "../../popup/services/popup-utils.service";

const BrowserFido2MessageName = "BrowserFido2UserInterfaceServiceMessage";

export class SessionClosedError extends Error {
  constructor() {
    super("Fido2UserInterfaceSession was closed");
  }
}

export type BrowserFido2Message = { sessionId: string } & (
  | /**
   * This message is used by popouts to announce that they are ready
   * to recieve messages.
   **/ {
      type: "ConnectResponse";
    }
  /**
   * This message is used to announce the creation of a new session.
   * It iss used by popouts to know when to close.
   **/
  | {
      type: "NewSessionCreatedRequest";
    }
  | {
      type: "PickCredentialRequest";
      cipherIds: string[];
      userVerification: boolean;
      fallbackSupported: boolean;
    }
  | {
      type: "PickCredentialResponse";
      cipherId?: string;
      userVerified: boolean;
    }
  | {
      type: "ConfirmNewCredentialRequest";
      credentialName: string;
      userName: string;
      userVerification: boolean;
      fallbackSupported: boolean;
    }
  | {
      type: "ConfirmNewCredentialResponse";
      userVerified: boolean;
    }
  | {
      type: "ConfirmNewNonDiscoverableCredentialRequest";
      credentialName: string;
      userName: string;
      userVerification: boolean;
      fallbackSupported: boolean;
    }
  | {
      type: "ConfirmNewNonDiscoverableCredentialResponse";
      cipherId: string;
      userVerified: boolean;
    }
  | {
      type: "InformExcludedCredentialRequest";
      existingCipherIds: string[];
      fallbackSupported: boolean;
    }
  | {
      type: "InformCredentialNotFoundRequest";
      fallbackSupported: boolean;
    }
  | {
      type: "AbortRequest";
    }
  | {
      type: "AbortResponse";
      fallbackRequested: boolean;
    }
);

export class BrowserFido2UserInterfaceService implements Fido2UserInterfaceServiceAbstraction {
  constructor(private popupUtilsService: PopupUtilsService, private authService: AuthService) {}

  async newSession(
    fallbackSupported: boolean,
    abortController?: AbortController
  ): Promise<Fido2UserInterfaceSession> {
    return await BrowserFido2UserInterfaceSession.create(
      this.popupUtilsService,
      this.authService,
      fallbackSupported,
      abortController
    );
  }
}

export class BrowserFido2UserInterfaceSession implements Fido2UserInterfaceSession {
  static async create(
    popupUtilsService: PopupUtilsService,
    authService: AuthService,
    fallbackSupported: boolean,
    abortController?: AbortController
  ): Promise<BrowserFido2UserInterfaceSession> {
    return new BrowserFido2UserInterfaceSession(
      popupUtilsService,
      authService,
      fallbackSupported,
      abortController
    );
  }

  static sendMessage(msg: BrowserFido2Message) {
    BrowserApi.sendMessage(BrowserFido2MessageName, msg);
  }

  private closed = false;
  private messages$ = (BrowserApi.messageListener$() as Observable<BrowserFido2Message>).pipe(
    filter((msg) => msg.sessionId === this.sessionId)
  );
  private windowClosed$: Observable<number>;
  private tabClosed$: Observable<number>;
  private connected$ = new BehaviorSubject(false);
  private destroy$ = new Subject<void>();
  private popout?: Popout;

  private constructor(
    private readonly popupUtilsService: PopupUtilsService,
    private readonly authService: AuthService,
    private readonly fallbackSupported: boolean,
    readonly abortController = new AbortController(),
    readonly sessionId = Utils.newGuid()
  ) {
    this.messages$
      .pipe(
        filter((msg) => msg.type === "ConnectResponse"),
        take(1),
        takeUntil(this.destroy$)
      )
      .subscribe(() => {
        this.connected$.next(true);
      });

    // Handle session aborted by RP
    fromEvent(abortController.signal, "abort")
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.close();
        BrowserFido2UserInterfaceSession.sendMessage({
          type: "AbortRequest",
          sessionId: this.sessionId,
        });
      });

    // Handle session aborted by user
    this.messages$
      .pipe(
        filter((msg) => msg.type === "AbortResponse"),
        take(1),
        takeUntil(this.destroy$)
      )
      .subscribe((msg) => {
        if (msg.type === "AbortResponse") {
          this.close();
          this.abort(msg.fallbackRequested);
        }
      });

    this.windowClosed$ = fromEventPattern(
      (handler: any) => chrome.windows.onRemoved.addListener(handler),
      (handler: any) => chrome.windows.onRemoved.removeListener(handler)
    );

    this.tabClosed$ = fromEventPattern(
      (handler: any) => chrome.windows.onRemoved.addListener(handler),
      (handler: any) => chrome.windows.onRemoved.removeListener(handler)
    );

    BrowserFido2UserInterfaceSession.sendMessage({
      type: "NewSessionCreatedRequest",
      sessionId,
    });
  }

  fallbackRequested = false;

  get aborted() {
    return this.abortController.signal.aborted;
  }

  async pickCredential({
    cipherIds,
    userVerification,
  }: PickCredentialParams): Promise<{ cipherId: string; userVerified: boolean }> {
    const data: BrowserFido2Message = {
      type: "PickCredentialRequest",
      cipherIds,
      sessionId: this.sessionId,
      userVerification,
      fallbackSupported: this.fallbackSupported,
    };

    await this.send(data);
    const response = await this.receive("PickCredentialResponse");

    return { cipherId: response.cipherId, userVerified: response.userVerified };
  }

  async confirmNewCredential({
    credentialName,
    userName,
    userVerification,
  }: NewCredentialParams): Promise<{ confirmed: boolean; userVerified: boolean }> {
    const data: BrowserFido2Message = {
      type: "ConfirmNewCredentialRequest",
      sessionId: this.sessionId,
      credentialName,
      userName,
      userVerification,
      fallbackSupported: this.fallbackSupported,
    };

    await this.send(data);
    const response = await this.receive("ConfirmNewCredentialResponse");

    return { confirmed: true, userVerified: response.userVerified };
  }

  async confirmNewNonDiscoverableCredential({
    credentialName,
    userName,
    userVerification,
  }: NewCredentialParams): Promise<{ cipherId: string; userVerified: boolean }> {
    const data: BrowserFido2Message = {
      type: "ConfirmNewNonDiscoverableCredentialRequest",
      sessionId: this.sessionId,
      credentialName,
      userName,
      userVerification,
      fallbackSupported: this.fallbackSupported,
    };

    await this.send(data);
    const response = await this.receive("ConfirmNewNonDiscoverableCredentialResponse");

    return { cipherId: response.cipherId, userVerified: response.userVerified };
  }

  async informExcludedCredential(existingCipherIds: string[]): Promise<void> {
    const data: BrowserFido2Message = {
      type: "InformExcludedCredentialRequest",
      sessionId: this.sessionId,
      existingCipherIds,
      fallbackSupported: this.fallbackSupported,
    };

    await this.send(data);
    await this.receive("AbortResponse");
  }

  async ensureUnlockedVault(): Promise<void> {
    await this.connect();
  }

  async informCredentialNotFound(): Promise<void> {
    const data: BrowserFido2Message = {
      type: "InformCredentialNotFoundRequest",
      sessionId: this.sessionId,
      fallbackSupported: this.fallbackSupported,
    };

    await this.send(data);
    await this.receive("AbortResponse");
  }

  async close() {
    this.popupUtilsService.closePopOut(this.popout);
    this.closed = true;
    this.destroy$.next();
    this.destroy$.complete();
  }

  async abort(fallback = false) {
    this.abortController.abort(fallback ? UserRequestedFallbackAbortReason : undefined);
  }

  private async send(msg: BrowserFido2Message): Promise<void> {
    if (!this.connected$.value) {
      await this.connect();
    }
    BrowserFido2UserInterfaceSession.sendMessage(msg);
  }

  private async receive<T extends BrowserFido2Message["type"]>(
    type: T
  ): Promise<BrowserFido2Message & { type: T }> {
    try {
      const response = await firstValueFrom(
        this.messages$.pipe(
          filter((msg) => msg.sessionId === this.sessionId && msg.type === type),
          takeUntil(this.destroy$)
        )
      );
      return response as BrowserFido2Message & { type: T };
    } catch (error) {
      if (error instanceof EmptyError) {
        throw new SessionClosedError();
      }
      throw error;
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot re-open closed session");
    }

    // create promise first to avoid race condition where the popout opens before we start listening
    const connectPromise = firstValueFrom(
      merge(
        this.connected$.pipe(filter((connected) => connected === true)),
        fromEvent(this.abortController.signal, "abort").pipe(
          switchMap(() => throwError(() => new SessionClosedError()))
        )
      )
    );

    const authStatus = await this.authService.getAuthStatus();
    this.popout = await this.generatePopOut(authStatus);

    if (this.popout.type === "window") {
      const popoutWindow = this.popout;
      this.windowClosed$
        .pipe(
          filter((windowId) => popoutWindow.window.id === windowId),
          takeUntil(this.destroy$)
        )
        .subscribe(() => {
          this.close();
          this.abort();
        });
    } else if (this.popout.type === "tab") {
      const popoutTab = this.popout;
      this.tabClosed$
        .pipe(
          filter((tabId) => popoutTab.tab.id === tabId),
          takeUntil(this.destroy$)
        )
        .subscribe(() => {
          this.close();
          this.abort();
        });
    }

    await connectPromise;
  }

  private async generatePopOut(authStatus: AuthenticationStatus) {
    if (authStatus === AuthenticationStatus.Unlocked) {
      const queryParams = new URLSearchParams({ sessionId: this.sessionId });
      return this.popupUtilsService.popOut(
        null,
        `popup/index.html?uilocation=popout#/fido2?${queryParams.toString()}`,
        { center: true }
      );
    }

    let path: string;

    switch (authStatus) {
      case AuthenticationStatus.LoggedOut:
        path = "home";
        break;
      case AuthenticationStatus.Locked:
        path = "lock";
        break;
      default:
        throw new Error(`Unexpected auth status: ${authStatus}`);
    }

    const redirectUrlParams = new URLSearchParams({ sessionId: this.sessionId });
    const redirectUrl = `/fido2?${redirectUrlParams.toString()}`;

    const queryParams = new URLSearchParams({ redirectUrl });
    return this.popupUtilsService.popOut(
      null,
      `popup/index.html?uilocation=popout#/${path}?${queryParams.toString()}`,
      { center: true }
    );
  }
}