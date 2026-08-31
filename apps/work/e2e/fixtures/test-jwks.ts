/**
 * TEST-ONLY RSA key pair for E2E auth injection (US-006).
 *
 * This key exists solely so Playwright can mint an RS256 id_token that the
 * server verifies via the COGNITO_TEST_JWKS override (which the server
 * ignores when VERCEL_ENV === 'production'). It grants no real access
 * anywhere and is intentionally committed.
 */

export const TEST_ISSUER = "https://e2e-test-issuer.invalid";
export const TEST_CLIENT_ID = "e2e-test-client";

export const TEST_PUBLIC_JWK = {
  kty: "RSA",
  n: "0OL-azkWOZA3uS0vME9jA-IjNb7lsguUyD-hAdDRInsBvsGRlJ_DDtNy4R3gMXqt820YQpCbUPm5W2mEr99wcgdeWYG9Gw1YNQRxQAE6ybNymbjCYkWAcN_9XQeI2AD5K_gylJ8GX2DYoXPrsL7tTFqSJ7zD43QfPIjcqbzVU570fTwGEN2CIVdMKG_U2ej1tpkxkbcxLqcE5dcam89yY59VXnSEMujnLYUCFR0O_K-nnWj4FIMGoUmHDvQSOHkkvSIqLj25cLBRr_7B17WACqbM03VecTNSQchoE1dqQ8F9U6TvpdA9rVQOxWf0e66njY4j_NXfRECrKT5Yv0gTtQ",
  e: "AQAB",
  kid: "e2e-test-key",
  alg: "RS256",
  use: "sig",
} as const;

export const TEST_PRIVATE_JWK = {
  kty: "RSA",
  n: "0OL-azkWOZA3uS0vME9jA-IjNb7lsguUyD-hAdDRInsBvsGRlJ_DDtNy4R3gMXqt820YQpCbUPm5W2mEr99wcgdeWYG9Gw1YNQRxQAE6ybNymbjCYkWAcN_9XQeI2AD5K_gylJ8GX2DYoXPrsL7tTFqSJ7zD43QfPIjcqbzVU570fTwGEN2CIVdMKG_U2ej1tpkxkbcxLqcE5dcam89yY59VXnSEMujnLYUCFR0O_K-nnWj4FIMGoUmHDvQSOHkkvSIqLj25cLBRr_7B17WACqbM03VecTNSQchoE1dqQ8F9U6TvpdA9rVQOxWf0e66njY4j_NXfRECrKT5Yv0gTtQ",
  e: "AQAB",
  d: "AqoinLOJuQpB67bL103r8Wy9Dj51J6RGLZfCMge74zi2ePx3IvI2xsWjvYNoDLmH5ocJvC-kC5Bj8OqTqrqq8IlvhqzFAMdWzLZVy384hMIpQBS_Rgmk7cutq7Yg5MB-bTUpUAQHTMgre0PDSenllQfCvYcG6KveiiMkzXV_MyXaCbtbidk5eRYkAeZVNwpMZa1hc5ZbM-lpjl9RrNna5pGx5p3P46Y1hYNHxNXOiE0qvcfPRBIr7NQD7FwA2ldDeqoYtVnl5_Ztul9WyjEWOTNoINYH4LoqOPLd-wd6_Gf3wcHgCOIK-zroUJ797MoVU5lhDPnCtr3LhCO3UIzVgQ",
  p: "7UGDt1WGsTffgtTIrFVt6Pi_T_r0cB37xqIoWdP2I6Ur5bBonaxO5DCJoheEpxESzktmjaOSrUK-pIgrxGarq-uF7nNkSHwAylRxxI22z2zdiVeeNRbibg7V2_qafWZW-0Tr0PZizJ2e2S_1oh30aetMfLI0rArbhbme_cwKNUk",
  q: "4WO2sZPoyNrjPa2T1M4fWyQyVuGJjiaHRa36rlr6dJXY9Riy8RorafacqqxFTsb1VVsG_rAxRNpGD7t5iliA-NdAjzDdV-NvUTez1GY0dR8f0rhsYNpNidRMSpjnLdF81NI0SLYj_Yhkgau06RfoI2VoppIJaPcYgyjQhIO7Zw0",
  dp: "KPSDOTWRT6w2cA4tKdqBY5L062iFo4j5eltpncACIDsV7cta88TXxXo_d_SZWIGQ_n1zkYWn_zKjWCGNdJTIk5_Pec7_g6esN0EGdoiEAyBmyZuPWti9c4QqFJQY8Qamgy9tiZ_OhEW9Mv6dZ0PGejY8-NWGVCB3rojRUjxTksk",
  dq: "tXqVYtyGhhuA92uo6aNiKf-2LLCDEptBNkDE5NjKa08wlwDhLDL3G-X-9YmqcKjQZ37Y3f--XAMogIhib5udlT-0ctdUkezF9-5S9MWqnVeHRyNJ2J5N6pmvKC1_jyvrSG1MvfMyfXTyAFriWwDt4HpJzj0uKH81FH6rjteG8I0",
  qi: "IWzM0Ot6QNDFJwE6RQCZq5pYjJ51ysum5445FhgiPGa89yHpE9rsdYO-Y2WTe12GfueLOb341HMRGekX090qw_2dqFox0xjaHYvQIwjzRSwzxY5JQ6Hvpk7MNLgvZV2Sj9Z7AnI1JtoxUYiCpIeOhKcAvGmqGnTD1zByChgv3zk",
  kid: "e2e-test-key",
  alg: "RS256",
  use: "sig",
} as const;

export const TEST_JWKS = JSON.stringify({ keys: [TEST_PUBLIC_JWK] });
