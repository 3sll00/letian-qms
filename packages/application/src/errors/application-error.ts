import type { ProblemDetails, InvalidParamDetail } from '@letian/contracts';
import { ErrorCode, type ErrorCodeType } from '@letian/contracts';

/**
 * RFC 7807 统一业务异常基类
 */
export class ApplicationError extends Error {
  public readonly type: string;
  public readonly title: string;
  public readonly status: number;
  public readonly detail: string;
  public readonly code: ErrorCodeType;
  public readonly traceId: string;
  public readonly instance?: string;
  public readonly invalidParams?: InvalidParamDetail[];

  constructor(
    codeOrParams:
      | ErrorCodeType
      | string
      | {
          code: ErrorCodeType;
          title: string;
          status: number;
          detail: string;
          traceId?: string;
          instance?: string;
          invalidParams?: InvalidParamDetail[];
        },
    legacyDetail?: string,
    legacyStatus?: number,
    legacyTraceId?: string
  ) {
    let resolvedCode: ErrorCodeType;
    let resolvedTitle: string;
    let resolvedStatus: number;
    let resolvedDetail: string;
    let resolvedTraceId: string | undefined;
    let resolvedInstance: string | undefined;
    let resolvedInvalidParams: InvalidParamDetail[] | undefined;

    if (typeof codeOrParams === 'object' && codeOrParams !== null) {
      resolvedCode = codeOrParams.code;
      resolvedTitle = codeOrParams.title;
      resolvedStatus = codeOrParams.status;
      resolvedDetail = codeOrParams.detail;
      resolvedTraceId = codeOrParams.traceId;
      resolvedInstance = codeOrParams.instance;
      resolvedInvalidParams = codeOrParams.invalidParams;
    } else {
      resolvedCode = (codeOrParams as ErrorCodeType) ?? ErrorCode.INTERNAL_SERVER_ERROR;
      resolvedDetail = legacyDetail ?? 'An application error occurred';
      resolvedStatus = legacyStatus ?? 500;
      resolvedTitle = legacyDetail ?? '业务处理异常';
      resolvedTraceId = legacyTraceId;
    }

    super(resolvedDetail);
    this.name = 'ApplicationError';
    this.code = resolvedCode;
    this.type = `https://letian-qms.com/errors/${resolvedCode}`;
    this.title = resolvedTitle;
    this.status = resolvedStatus;
    this.detail = resolvedDetail;
    this.traceId = resolvedTraceId ?? `trace_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    if (resolvedInstance !== undefined) {
      this.instance = resolvedInstance;
    }
    if (resolvedInvalidParams !== undefined) {
      this.invalidParams = resolvedInvalidParams;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toProblemDetails(): ProblemDetails {
    const res: ProblemDetails = {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.detail,
      code: this.code,
      traceId: this.traceId,
    };
    if (this.instance !== undefined) {
      res.instance = this.instance;
    }
    if (this.invalidParams !== undefined) {
      res.invalidParams = this.invalidParams;
    }
    return res;
  }
}

export class UnauthorizedError extends ApplicationError {
  constructor(message: string, code: ErrorCodeType = ErrorCode.UNAUTHORIZED, traceId?: string) {
    const params: {
      code: ErrorCodeType;
      title: string;
      status: number;
      detail: string;
      traceId?: string;
    } = {
      code,
      title: '身份认证失败',
      status: 401,
      detail: message,
    };
    if (traceId !== undefined) params.traceId = traceId;
    super(params);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(message: string, code: ErrorCodeType = ErrorCode.RESOURCE_NOT_FOUND, traceId?: string) {
    const params: {
      code: ErrorCodeType;
      title: string;
      status: number;
      detail: string;
      traceId?: string;
    } = {
      code,
      title: '资源未找到',
      status: 404,
      detail: message,
    };
    if (traceId !== undefined) params.traceId = traceId;
    super(params);
  }
}

export class ValidationFailedError extends ApplicationError {
  constructor(message: string, invalidParams?: InvalidParamDetail[], traceId?: string) {
    const params: {
      code: ErrorCodeType;
      title: string;
      status: number;
      detail: string;
      invalidParams?: InvalidParamDetail[];
      traceId?: string;
    } = {
      code: ErrorCode.VALIDATION_FAILED,
      title: '参数或规则校验失败',
      status: 400,
      detail: message,
    };
    if (invalidParams !== undefined) params.invalidParams = invalidParams;
    if (traceId !== undefined) params.traceId = traceId;
    super(params);
  }
}

export class ForbiddenError extends ApplicationError {
  constructor(message: string, code: ErrorCodeType = ErrorCode.PBAC_PERMISSION_DENIED, traceId?: string) {
    const params: {
      code: ErrorCodeType;
      title: string;
      status: number;
      detail: string;
      traceId?: string;
    } = {
      code,
      title: '权限不足或数据越权',
      status: 403,
      detail: message,
    };
    if (traceId !== undefined) params.traceId = traceId;
    super(params);
  }
}

export class ConflictError extends ApplicationError {
  constructor(message: string, code: ErrorCodeType = ErrorCode.CONFLICT, traceId?: string) {
    const params: {
      code: ErrorCodeType;
      title: string;
      status: number;
      detail: string;
      traceId?: string;
    } = {
      code,
      title: '资源状态冲突或并发写冲突',
      status: 409,
      detail: message,
    };
    if (traceId !== undefined) params.traceId = traceId;
    super(params);
  }
}

export class GateBlockedError extends ApplicationError {
  constructor(message: string, code: ErrorCodeType = ErrorCode.GATE_FAILED, traceId?: string) {
    const params: {
      code: ErrorCodeType;
      title: string;
      status: number;
      detail: string;
      traceId?: string;
    } = {
      code,
      title: '放行关卡阻断',
      status: 422,
      detail: message,
    };
    if (traceId !== undefined) params.traceId = traceId;
    super(params);
  }
}
