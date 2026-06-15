import { describe, expect, it } from "@jest/globals";
import "@testing-library/jest-dom";
import { calculateRank } from "../src/calculateRank.js";

describe("Test calculateRank", () => {
  it("new user gets C rank", () => {
    expect(
      calculateRank({
        all_commits: false,
        commits: 0,
        prs: 0,
        issues: 0,
        reviews: 0,
        repos: 0,
        stars: 0,
        followers: 0,
      }),
    ).toStrictEqual({ level: "C", percentile: 100 });
  });

  it("beginner user gets B- rank", () => {
    expect(
      calculateRank({
        all_commits: false,
        commits: 125,
        prs: 25,
        issues: 10,
        reviews: 5,
        repos: 0,
        stars: 25,
        followers: 5,
        lines_changed: 25000,
        github_actions: 100,
      }),
    ).toStrictEqual({ level: "B-", percentile: 65.62628221558525 });
  });

  it("median user gets B+ rank", () => {
    expect(
      calculateRank({
        all_commits: false,
        commits: 250,
        prs: 50,
        issues: 25,
        reviews: 10,
        repos: 0,
        stars: 50,
        followers: 10,
        lines_changed: 50000,
        github_actions: 200,
      }),
    ).toStrictEqual({ level: "B+", percentile: 46.875 });
  });

  it("average user gets B+ rank (include_all_commits)", () => {
    expect(
      calculateRank({
        all_commits: true,
        commits: 1000,
        prs: 50,
        issues: 25,
        reviews: 10,
        repos: 0,
        stars: 50,
        followers: 10,
        lines_changed: 50000,
        github_actions: 200,
      }),
    ).toStrictEqual({ level: "B+", percentile: 46.875 });
  });

  it("advanced user gets A rank", () => {
    expect(
      calculateRank({
        all_commits: false,
        commits: 500,
        prs: 100,
        issues: 50,
        reviews: 20,
        repos: 0,
        stars: 200,
        followers: 40,
        lines_changed: 200000,
        github_actions: 800,
      }),
    ).toStrictEqual({ level: "A", percentile: 19.75651041666667 });
  });

  it("expert user gets A+ rank", () => {
    expect(
      calculateRank({
        all_commits: false,
        commits: 1000,
        prs: 200,
        issues: 100,
        reviews: 40,
        repos: 0,
        stars: 800,
        followers: 160,
        lines_changed: 800000,
        github_actions: 3200,
      }),
    ).toStrictEqual({ level: "A+", percentile: 5.245206122304868 });
  });

  it("sindresorhus gets S rank", () => {
    expect(
      calculateRank({
        all_commits: false,
        commits: 1300,
        prs: 1500,
        issues: 4500,
        reviews: 1000,
        repos: 0,
        stars: 600000,
        followers: 50000,
        lines_changed: 10000000,
        github_actions: 100000,
      }),
    ).toStrictEqual({ level: "S", percentile: 0.43261951548042576 });
  });
});
