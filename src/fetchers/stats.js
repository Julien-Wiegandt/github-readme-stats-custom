// @ts-check

import axios from "axios";
import * as dotenv from "dotenv";
import githubUsernameRegex from "github-username-regex";
import { calculateRank } from "../calculateRank.js";
import { retryer } from "../common/retryer.js";
import { logger } from "../common/log.js";
import { excludeRepositories } from "../common/envs.js";
import { CustomError, MissingParamError } from "../common/error.js";
import { wrapTextMultiline } from "../common/fmt.js";
import { request } from "../common/http.js";

dotenv.config();

// GraphQL queries.
const GRAPHQL_REPOS_FIELD = `
  repositories(first: 100, ownerAffiliations: OWNER, orderBy: {direction: DESC, field: STARGAZERS}, after: $after) {
    totalCount
    nodes {
      name
      stargazers {
        totalCount
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`;

const GRAPHQL_REPOS_QUERY = `
  query userInfo($login: String!, $after: String) {
    user(login: $login) {
      ${GRAPHQL_REPOS_FIELD}
    }
  }
`;

const GRAPHQL_STATS_QUERY = `
  query userInfo($login: String!, $after: String, $includeMergedPullRequests: Boolean!, $includeDiscussions: Boolean!, $includeDiscussionsAnswers: Boolean!, $startTime: DateTime = null) {
    user(login: $login) {
      name
      login
      commits: contributionsCollection (from: $startTime) {
        totalCommitContributions,
      }
      reviews: contributionsCollection {
        totalPullRequestReviewContributions
      }
      repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
        totalCount
      }
      pullRequests(first: 1) {
        totalCount
      }
      mergedPullRequests: pullRequests(states: MERGED) @include(if: $includeMergedPullRequests) {
        totalCount
      }
      openIssues: issues(states: OPEN) {
        totalCount
      }
      closedIssues: issues(states: CLOSED) {
        totalCount
      }
      followers {
        totalCount
      }
      repositoryDiscussions @include(if: $includeDiscussions) {
        totalCount
      }
      repositoryDiscussionComments(onlyAnswers: true) @include(if: $includeDiscussionsAnswers) {
        totalCount
      }
      ${GRAPHQL_REPOS_FIELD}
    }
  }
`;

/**
 * Stats fetcher object.
 *
 * @param {object & { after: string | null }} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 */
const fetcher = (variables, token) => {
  const query = variables.after ? GRAPHQL_REPOS_QUERY : GRAPHQL_STATS_QUERY;
  return request(
    {
      query,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * Fetch stats information for a given username.
 *
 * @param {object} variables Fetcher variables.
 * @param {string} variables.username GitHub username.
 * @param {boolean} variables.includeMergedPullRequests Include merged pull requests.
 * @param {boolean} variables.includeDiscussions Include discussions.
 * @param {boolean} variables.includeDiscussionsAnswers Include discussions answers.
 * @param {string|undefined} variables.startTime Time to start the count of total commits.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 *
 * @description This function supports multi-page fetching if the 'FETCH_MULTI_PAGE_STARS' environment variable is set to true.
 */
const statsFetcher = async ({
  username,
  includeMergedPullRequests,
  includeDiscussions,
  includeDiscussionsAnswers,
  startTime,
}) => {
  let stats;
  let hasNextPage = true;
  let endCursor = null;
  while (hasNextPage) {
    const variables = {
      login: username,
      first: 100,
      after: endCursor,
      includeMergedPullRequests,
      includeDiscussions,
      includeDiscussionsAnswers,
      startTime,
    };
    let res = await retryer(fetcher, variables);
    if (res.data.errors) {
      return res;
    }

    // Store stats data.
    const repoNodes = res.data.data.user.repositories.nodes;
    if (stats) {
      stats.data.data.user.repositories.nodes.push(...repoNodes);
    } else {
      stats = res;
    }

    // Disable multi page fetching on public Vercel instance due to rate limits.
    const repoNodesWithStars = repoNodes.filter(
      (node) => node.stargazers.totalCount !== 0,
    );
    hasNextPage =
      process.env.FETCH_MULTI_PAGE_STARS === "true" &&
      repoNodes.length === repoNodesWithStars.length &&
      res.data.data.user.repositories.pageInfo.hasNextPage;
    endCursor = res.data.data.user.repositories.pageInfo.endCursor;
  }

  return stats;
};

// Maximum number of repositories to inspect when computing the (expensive)
// per-repo stats (lines of code, GitHub Actions runs). Prevents runaway API
// usage for users with a very large number of repositories.
const MAX_REPOS_FOR_DETAILED_STATS = 300;

// GraphQL query to list the repositories owned by a user (paginated).
const GRAPHQL_OWNED_REPO_NAMES_QUERY = `
  query userRepoNames($login: String!, $after: String) {
    user(login: $login) {
      repositories(first: 100, ownerAffiliations: OWNER, after: $after) {
        nodes {
          nameWithOwner
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

// GraphQL query to list the repositories a user has contributed to (paginated).
const GRAPHQL_CONTRIB_REPO_NAMES_QUERY = `
  query userContribRepoNames($login: String!, $after: String) {
    user(login: $login) {
      repositoriesContributedTo(first: 100, after: $after, contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY]) {
        nodes {
          nameWithOwner
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

/**
 * Pause execution for a given number of milliseconds.
 *
 * @param {number} ms Milliseconds to sleep.
 * @returns {Promise<void>} Promise that resolves after the delay.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an async task over a list of items with a bounded concurrency.
 *
 * @template T, R
 * @param {T[]} items Items to process.
 * @param {number} limit Maximum number of concurrent tasks.
 * @param {(item: T, index: number) => Promise<R>} task Task to run per item.
 * @returns {Promise<R[]>} Results in the same order as the input items.
 */
const mapWithConcurrency = async (items, limit, task) => {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
};

/**
 * Fetch every repository name (owner/name) reachable through a GraphQL
 * connection, following pagination until exhausted.
 *
 * @param {string} username GitHub username.
 * @param {string} query GraphQL query to execute.
 * @param {string} field Name of the connection field on the user object.
 * @returns {Promise<string[]>} List of "owner/name" repository identifiers.
 */
const fetchRepoNames = async (username, query, field) => {
  const names = [];
  let hasNextPage = true;
  let after = null;
  while (hasNextPage) {
    const res = await retryer(
      (variables, token) =>
        request({ query, variables }, { Authorization: `bearer ${token}` }),
      { login: username, after },
    );
    if (res.data.errors || !res.data.data?.user?.[field]) {
      break;
    }
    const connection = res.data.data.user[field];
    names.push(...connection.nodes.map((node) => node.nameWithOwner));
    hasNextPage = connection.pageInfo.hasNextPage;
    after = connection.pageInfo.endCursor;
  }
  return names;
};

/**
 * Fetch the list of repositories to inspect for detailed stats: the ones owned
 * by the user plus the ones they contributed to (deduplicated).
 *
 * @param {string} username GitHub username.
 * @returns {Promise<string[]>} Deduplicated list of "owner/name" identifiers.
 */
const fetchUserRepositories = async (username) => {
  const [owned, contributed] = await Promise.all([
    fetchRepoNames(username, GRAPHQL_OWNED_REPO_NAMES_QUERY, "repositories"),
    fetchRepoNames(
      username,
      GRAPHQL_CONTRIB_REPO_NAMES_QUERY,
      "repositoriesContributedTo",
    ),
  ]);
  return [...new Set([...owned, ...contributed])];
};

/**
 * Fetch the number of lines added/removed by a user in a single repository.
 *
 * @param {string} nameWithOwner Repository identifier ("owner/name").
 * @param {string} username GitHub username.
 * @param {string} token GitHub token.
 * @param {number} retries Current retry count (the stats endpoint returns 202
 *   while GitHub computes the statistics).
 * @returns {Promise<{additions: number, deletions: number}>} Lines changed.
 *
 * @see https://docs.github.com/en/rest/metrics/statistics#get-all-contributor-commit-activity
 */
const fetchRepoLinesOfCode = async (
  nameWithOwner,
  username,
  token,
  retries = 0,
) => {
  const MAX_202_RETRIES = 3;
  const empty = { additions: 0, deletions: 0 };
  let res;
  try {
    res = await axios({
      method: "get",
      url: `https://api.github.com/repos/${nameWithOwner}/stats/contributors`,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `token ${token}`,
      },
    });
  } catch {
    // Skip repositories we cannot access (e.g. revoked permissions).
    return empty;
  }

  // 202 means GitHub is still computing the statistics; back off and retry.
  if (res.status === 202) {
    if (retries >= MAX_202_RETRIES) {
      return empty;
    }
    await sleep(2000);
    return fetchRepoLinesOfCode(nameWithOwner, username, token, retries + 1);
  }

  if (!Array.isArray(res.data)) {
    return empty;
  }

  const contributor = res.data.find(
    (entry) => entry.author?.login?.toLowerCase() === username.toLowerCase(),
  );
  if (!contributor) {
    return empty;
  }

  return contributor.weeks.reduce(
    (acc, week) => ({
      additions: acc.additions + (week.a || 0),
      deletions: acc.deletions + (week.d || 0),
    }),
    { additions: 0, deletions: 0 },
  );
};

/**
 * Fetch the number of GitHub Actions workflow runs triggered by a user in a
 * single repository.
 *
 * @param {string} nameWithOwner Repository identifier ("owner/name").
 * @param {string} username GitHub username.
 * @param {string} token GitHub token.
 * @returns {Promise<number>} Number of workflow runs triggered by the user.
 *
 * @see https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository
 */
const fetchRepoActionRuns = async (nameWithOwner, username, token) => {
  try {
    const res = await axios({
      method: "get",
      url: `https://api.github.com/repos/${nameWithOwner}/actions/runs`,
      params: { actor: username, per_page: 1 },
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `token ${token}`,
      },
    });
    return res.data.total_count || 0;
  } catch {
    // Skip repositories without Actions enabled or that we cannot access.
    return 0;
  }
};

/**
 * Aggregate lines of code added/removed by a user across the given repositories.
 *
 * @param {string} username GitHub username.
 * @param {string[]} repos List of "owner/name" identifiers.
 * @param {string} token GitHub token.
 * @returns {Promise<{additions: number, deletions: number}>} Aggregated totals.
 */
const fetchLinesOfCode = async (username, repos, token) => {
  const perRepo = await mapWithConcurrency(repos, 10, (repo) =>
    fetchRepoLinesOfCode(repo, username, token),
  );
  return perRepo.reduce(
    (acc, { additions, deletions }) => ({
      additions: acc.additions + additions,
      deletions: acc.deletions + deletions,
    }),
    { additions: 0, deletions: 0 },
  );
};

/**
 * Aggregate the number of GitHub Actions runs a user triggered across the given
 * repositories.
 *
 * @param {string} username GitHub username.
 * @param {string[]} repos List of "owner/name" identifiers.
 * @param {string} token GitHub token.
 * @returns {Promise<number>} Total workflow runs triggered by the user.
 */
const fetchGithubActions = async (username, repos, token) => {
  const perRepo = await mapWithConcurrency(repos, 10, (repo) =>
    fetchRepoActionRuns(repo, username, token),
  );
  return perRepo.reduce((acc, count) => acc + count, 0);
};

/**
 * Fetch total commits using the REST API.
 *
 * @param {object} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 *
 * @see https://developer.github.com/v3/search/#search-commits
 */
const fetchTotalCommits = (variables, token) => {
  return axios({
    method: "get",
    url: `https://api.github.com/search/commits?q=author:${variables.login}`,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.github.cloak-preview",
      Authorization: `token ${token}`,
    },
  });
};

/**
 * Fetch all the commits for all the repositories of a given username.
 *
 * @param {string} username GitHub username.
 * @returns {Promise<number>} Total commits.
 *
 * @description Done like this because the GitHub API does not provide a way to fetch all the commits. See
 * #92#issuecomment-661026467 and #211 for more information.
 */
const totalCommitsFetcher = async (username) => {
  if (!githubUsernameRegex.test(username)) {
    logger.log("Invalid username provided.");
    throw new Error("Invalid username provided.");
  }

  let res;
  try {
    res = await retryer(fetchTotalCommits, { login: username });
  } catch (err) {
    logger.log(err);
    throw new Error(err);
  }

  const totalCount = res.data.total_count;
  if (!totalCount || isNaN(totalCount)) {
    throw new CustomError(
      "Could not fetch total commits.",
      CustomError.GITHUB_REST_API_ERROR,
    );
  }
  return totalCount;
};

/**
 * Fetch stats for a given username.
 *
 * @param {string} username GitHub username.
 * @param {boolean} include_all_commits Include all commits.
 * @param {string[]} exclude_repo Repositories to exclude.
 * @param {boolean} include_merged_pull_requests Include merged pull requests.
 * @param {boolean} include_discussions Include discussions.
 * @param {boolean} include_discussions_answers Include discussions answers.
 * @param {number|undefined} commits_year Year to count total commits
 * @param {boolean} include_lines_changed Include lines of code added/removed.
 * @param {boolean} include_github_actions Include GitHub Actions runs count.
 * @returns {Promise<import("./types").StatsData>} Stats data.
 */
const fetchStats = async (
  username,
  include_all_commits = false,
  exclude_repo = [],
  include_merged_pull_requests = false,
  include_discussions = false,
  include_discussions_answers = false,
  commits_year,
  include_lines_changed = false,
  include_github_actions = false,
) => {
  if (!username) {
    throw new MissingParamError(["username"]);
  }

  const stats = {
    name: "",
    totalPRs: 0,
    totalPRsMerged: 0,
    mergedPRsPercentage: 0,
    totalReviews: 0,
    totalCommits: 0,
    totalIssues: 0,
    totalStars: 0,
    totalDiscussionsStarted: 0,
    totalDiscussionsAnswered: 0,
    contributedTo: 0,
    linesAdded: 0,
    linesRemoved: 0,
    totalGithubActions: 0,
    rank: { level: "C", percentile: 100 },
  };

  let res = await statsFetcher({
    username,
    includeMergedPullRequests: include_merged_pull_requests,
    includeDiscussions: include_discussions,
    includeDiscussionsAnswers: include_discussions_answers,
    startTime: commits_year ? `${commits_year}-01-01T00:00:00Z` : undefined,
  });

  // Catch GraphQL errors.
  if (res.data.errors) {
    logger.error(res.data.errors);
    if (res.data.errors[0].type === "NOT_FOUND") {
      throw new CustomError(
        res.data.errors[0].message || "Could not fetch user.",
        CustomError.USER_NOT_FOUND,
      );
    }
    if (res.data.errors[0].message) {
      throw new CustomError(
        wrapTextMultiline(res.data.errors[0].message, 90, 1)[0],
        res.statusText,
      );
    }
    throw new CustomError(
      "Something went wrong while trying to retrieve the stats data using the GraphQL API.",
      CustomError.GRAPHQL_ERROR,
    );
  }

  const user = res.data.data.user;

  stats.name = user.name || user.login;

  // if include_all_commits, fetch all commits using the REST API.
  if (include_all_commits) {
    stats.totalCommits = await totalCommitsFetcher(username);
  } else {
    stats.totalCommits = user.commits.totalCommitContributions;
  }

  stats.totalPRs = user.pullRequests.totalCount;
  if (include_merged_pull_requests) {
    stats.totalPRsMerged = user.mergedPullRequests.totalCount;
    stats.mergedPRsPercentage =
      (user.mergedPullRequests.totalCount / user.pullRequests.totalCount) *
        100 || 0;
  }
  stats.totalReviews = user.reviews.totalPullRequestReviewContributions;
  stats.totalIssues = user.openIssues.totalCount + user.closedIssues.totalCount;
  if (include_discussions) {
    stats.totalDiscussionsStarted = user.repositoryDiscussions.totalCount;
  }
  if (include_discussions_answers) {
    stats.totalDiscussionsAnswered =
      user.repositoryDiscussionComments.totalCount;
  }
  stats.contributedTo = user.repositoriesContributedTo.totalCount;

  // Retrieve stars while filtering out repositories to be hidden.
  const allExcludedRepos = [...exclude_repo, ...excludeRepositories];
  let repoToHide = new Set(allExcludedRepos);

  stats.totalStars = user.repositories.nodes
    .filter((data) => {
      return !repoToHide.has(data.name);
    })
    .reduce((prev, curr) => {
      return prev + curr.stargazers.totalCount;
    }, 0);

  // These stats are expensive (one REST call per repository) and have no
  // aggregate GitHub API endpoint, so they are only computed on demand.
  if (include_lines_changed || include_github_actions) {
    const token = process.env.PAT_1;
    let repos = await fetchUserRepositories(username);
    if (repos.length > MAX_REPOS_FOR_DETAILED_STATS) {
      logger.log(
        `Limiting detailed stats to ${MAX_REPOS_FOR_DETAILED_STATS} of ${repos.length} repositories for ${username}.`,
      );
      repos = repos.slice(0, MAX_REPOS_FOR_DETAILED_STATS);
    }

    if (include_lines_changed) {
      const { additions, deletions } = await fetchLinesOfCode(
        username,
        repos,
        token,
      );
      stats.linesAdded = additions;
      stats.linesRemoved = deletions;
    }
    if (include_github_actions) {
      stats.totalGithubActions = await fetchGithubActions(
        username,
        repos,
        token,
      );
    }
  }

  stats.rank = calculateRank({
    all_commits: include_all_commits,
    commits: stats.totalCommits,
    prs: stats.totalPRs,
    reviews: stats.totalReviews,
    issues: stats.totalIssues,
    repos: user.repositories.totalCount,
    stars: stats.totalStars,
    followers: user.followers.totalCount,
  });

  return stats;
};

export { fetchStats };
export default fetchStats;
