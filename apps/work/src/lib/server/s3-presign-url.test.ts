import { describe, expect, it } from "vitest";

import { isAllowedS3PresignUrl, s3UploadHeadersFrom } from "./s3-presign-url";

describe("isAllowedS3PresignUrl", () => {
  it("allows virtual-hosted and regional S3 HTTPS URLs", () => {
    expect(
      isAllowedS3PresignUrl(
        "https://hq-vault-cmp-x.s3.us-east-1.amazonaws.com/chat/attachments/a.png?X-Amz-Signature=1",
      ),
    ).toBe(true);
    expect(isAllowedS3PresignUrl("https://bucket.s3.amazonaws.com/key")).toBe(
      true,
    );
    expect(
      isAllowedS3PresignUrl("https://s3.us-east-1.amazonaws.com/bucket/key"),
    ).toBe(true);
  });

  it("rejects non-S3 and non-HTTPS targets", () => {
    expect(isAllowedS3PresignUrl("http://bucket.s3.amazonaws.com/key")).toBe(
      false,
    );
    expect(isAllowedS3PresignUrl("https://evil.example/steal")).toBe(false);
    expect(isAllowedS3PresignUrl("https://amazonaws.com.evil.tld/x")).toBe(
      false,
    );
    expect(isAllowedS3PresignUrl("not-a-url")).toBe(false);
    expect(
      isAllowedS3PresignUrl("https://lambda.us-east-1.amazonaws.com"),
    ).toBe(false);
  });
});

describe("s3UploadHeadersFrom", () => {
  it("forwards signed S3 headers and drops everything else", () => {
    const headers = s3UploadHeadersFrom(
      new Headers({
        "content-type": "image/png",
        "x-amz-server-side-encryption": "aws:kms",
        "x-hq-upload-url": "https://evil",
        cookie: "secret",
      }),
    );
    expect(headers).toEqual({
      "content-type": "image/png",
      "x-amz-server-side-encryption": "aws:kms",
    });
  });
});
