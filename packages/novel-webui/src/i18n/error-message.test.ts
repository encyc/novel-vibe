import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { i18n } from "./config";
import { localizeApiError } from "./error-message";

describe("localizeApiError", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("maps a known server code without exposing its server message", () => {
    const error = new ApiError(409, {
      error: { code: "DOCUMENT_CONFLICT", message: "English internal server wording" },
    });

    expect(localizeApiError(error)).toBe("文档已在其他位置更新，请处理冲突后重试。");
    expect(localizeApiError(error)).not.toContain("internal");
  });

  it("uses the current English locale", async () => {
    await i18n.changeLanguage("en");
    const error = new ApiError(400, {
      error: { code: "NICKNAME_REQUIRED", message: "请先设置昵称" },
    });

    expect(localizeApiError(error)).toBe("Set a display name before continuing.");
  });

  it("does not expose messages for unknown server codes", () => {
    const error = new ApiError(500, {
      error: { code: "SECRET_INTERNAL_ERROR", message: "database host leaked" },
    });

    expect(localizeApiError(error)).toBe("操作失败，请稍后重试。");
  });

  it("localizes browser network failures", () => {
    expect(localizeApiError(new TypeError("Failed to fetch"))).toBe("网络连接失败，请检查网络后重试。");
  });

  it("supports a localized fallback key for an operation", () => {
    expect(localizeApiError(new Error("raw SDK failure"), "workbench.document.exportFailed"))
      .toBe("导出失败");
  });

  it("localizes community validation codes instead of using the generic fallback", () => {
    const error = new ApiError(400, {
      error: { code: "INVALID_FEEDBACK_STATUS", message: "raw validation wording" },
    });

    expect(localizeApiError(error)).toBe("反馈状态无效。");
    expect(localizeApiError(error)).not.toBe(i18n.t("errors.UNKNOWN"));
  });

  it("localizes upstream and authentication codes in English", async () => {
    await i18n.changeLanguage("en");

    expect(localizeApiError(new ApiError(401, {
      error: { code: "AUTHENTICATION_FAILED", message: "raw auth wording" },
    }))).toBe("The email or password is incorrect.");
    expect(localizeApiError(new ApiError(503, {
      error: { code: "UPSTREAM_UNAVAILABLE", message: "raw upstream wording" },
    }))).toBe("The upstream service is temporarily unavailable. Please try again later.");
  });
});
