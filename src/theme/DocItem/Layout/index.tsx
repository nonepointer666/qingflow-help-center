import React, {type ReactNode, useEffect, useRef, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {useWindowSize} from '@docusaurus/theme-common';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import {Check, Copy, FileText, FolderOpen} from 'lucide-react';
import ContentVisibility from '@theme/ContentVisibility';
import DocBreadcrumbs from '@theme/DocBreadcrumbs';
import DocItemContent from '@theme/DocItem/Content';
import DocItemFooter from '@theme/DocItem/Footer';
import DocItemPaginator from '@theme/DocItem/Paginator';
import DocItemTOCDesktop from '@theme/DocItem/TOC/Desktop';
import DocItemTOCMobile from '@theme/DocItem/TOC/Mobile';
import DocVersionBadge from '@theme/DocVersionBadge';
import DocVersionBanner from '@theme/DocVersionBanner';
import type {Props} from '@theme/DocItem/Layout';
import {getSearchHighlightTerms} from '../../../utils/search-results.mjs';

import styles from './styles.module.css';

type CopyState = 'idle' | 'copied' | 'error';
type OutlineChildPage = {
  title: string;
  url: string;
  description?: string;
  pageType?: string;
};

const SEARCH_HIGHLIGHT_HOLD_MS = 2600;
const SEARCH_HIGHLIGHT_REMOVE_MS = 3600;
const SEARCH_SCROLL_MAX_SETTLE_MS = 10000;
const SEARCH_SCROLL_TOLERANCE_PX = 4;
const SEARCH_SCROLL_USER_INPUT_MS = 250;

function getTextMatches(value: string, terms: string[]): Array<{start: number; end: number}> {
  const normalized = value.toLocaleLowerCase();
  const matches: Array<{start: number; end: number}> = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const term = terms.find((candidate) => normalized.startsWith(candidate, cursor));
    if (term) {
      matches.push({start: cursor, end: cursor + term.length});
      cursor += term.length;
    } else {
      cursor += 1;
    }
  }

  return matches;
}

function getOutlineChildPages(value: unknown): OutlineChildPage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): OutlineChildPage[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.title !== 'string' ||
      typeof candidate.url !== 'string' ||
      !candidate.url.startsWith('/docs/')
    ) {
      return [];
    }
    return [{
      title: candidate.title,
      url: candidate.url,
      description: typeof candidate.description === 'string' ? candidate.description : undefined,
      pageType: typeof candidate.pageType === 'string' ? candidate.pageType : undefined,
    }];
  });
}

function OutlinePageNavigation({frontMatter}: {frontMatter: Record<string, unknown>}): ReactNode {
  if (frontMatter.source !== 'outline') return null;
  const pageType = String(frontMatter.page_type ?? 'content');
  const childPages = getOutlineChildPages(frontMatter.outline_children);

  if (childPages.length === 0) {
    if (pageType !== 'empty') return null;
    return (
      <section className={styles.emptyDocument} aria-label="文档状态">
        <FileText aria-hidden="true" size={19} strokeWidth={1.8} />
        <p>该页面暂时没有正文内容。</p>
      </section>
    );
  }

  return (
    <section className={styles.childNavigation} aria-labelledby="outline-child-navigation-title">
      <div className={styles.childNavigationHeading}>
        <h2 id="outline-child-navigation-title">本章节内容</h2>
        {pageType === 'directory' ? <p>选择一篇文档继续阅读。</p> : null}
      </div>
      <div className={styles.childNavigationList}>
        {childPages.map((child) => {
          const ChildIcon = ['directory', 'hybrid'].includes(child.pageType ?? '')
            ? FolderOpen
            : FileText;
          return (
            <Link className={styles.childNavigationItem} key={child.url} to={child.url}>
              <ChildIcon
                className={styles.childNavigationIcon}
                aria-hidden="true"
                size={20}
                strokeWidth={1.8}
              />
              <span className={styles.childNavigationCopy}>
                <strong>{child.title}</strong>
                {child.description ? <span>{child.description}</span> : null}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function highlightSearchTerms(root: HTMLElement, query: string): HTMLElement[] {
  const terms = getSearchHighlightTerms([query])
    .map((term: string) => term.toLocaleLowerCase())
    .filter(Boolean);
  if (terms.length === 0) return [];

  const ignoredTags = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT']);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !node.nodeValue?.trim() ||
        !parent ||
        ignoredTags.has(parent.tagName) ||
        parent.closest('[data-search-highlight], [data-no-search-highlight]')
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  const highlights: HTMLElement[] = [];
  textNodes.forEach((textNode) => {
    const text = textNode.nodeValue ?? '';
    const matches = getTextMatches(text, terms);
    if (matches.length === 0 || !textNode.parentNode) return;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    matches.forEach((match) => {
      if (match.start > cursor) fragment.append(text.slice(cursor, match.start));
      const mark = document.createElement('mark');
      mark.className = styles.searchHighlight;
      mark.dataset.searchHighlight = 'true';
      mark.textContent = text.slice(match.start, match.end);
      fragment.append(mark);
      highlights.push(mark);
      cursor = match.end;
    });
    if (cursor < text.length) fragment.append(text.slice(cursor));
    textNode.parentNode.replaceChild(fragment, textNode);
  });

  return highlights;
}

function removeSearchHighlights(highlights: HTMLElement[]) {
  highlights.forEach((highlight) => {
    const parent = highlight.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(highlight.textContent ?? ''), highlight);
    parent.normalize();
  });
}

function getHashTarget(hash: string): HTMLElement | null {
  if (!hash) return null;
  try {
    return document.getElementById(decodeURIComponent(hash));
  } catch {
    return document.getElementById(hash);
  }
}

function follows(reference: Node, candidate: Node): boolean {
  return Boolean(reference.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function findSearchScrollTarget(
  content: HTMLElement,
  highlights: HTMLElement[],
  hash: string,
): HTMLElement | null {
  const anchor = getHashTarget(hash);
  if (!anchor || !content.contains(anchor)) return highlights[0] ?? null;

  const headingLevel = /^H([1-6])$/.exec(anchor.tagName)?.[1];
  if (!headingLevel) {
    return anchor.querySelector<HTMLElement>('[data-search-highlight]') ?? anchor;
  }

  const level = Number(headingLevel);
  const boundary = Array.from(content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
    .find((heading) => {
      if (!follows(anchor, heading)) return false;
      const candidateLevel = Number(heading.tagName.slice(1));
      return candidateLevel <= level;
    });
  const sectionHighlight = highlights.find((highlight) => {
    const afterAnchor = anchor.contains(highlight) || follows(anchor, highlight);
    const beforeBoundary = !boundary || follows(highlight, boundary);
    return afterAnchor && beforeBoundary;
  });
  return sectionHighlight ?? anchor;
}

function stabilizeSearchScroll(
  content: HTMLElement,
  target: HTMLElement,
): () => void {
  let stopped = false;
  let scrollFrame: number | undefined;
  let userSettleTimer: number | undefined;
  let userScrollUntil = 0;
  let ignoreScrollUntil = 0;
  const cleanupCallbacks: Array<() => void> = [];
  const previousInlineScrollBehavior = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = 'auto';
  cleanupCallbacks.push(() => {
    document.documentElement.style.scrollBehavior = previousInlineScrollBehavior;
  });

  // Search highlights are removed after a few seconds. Keep a zero-size marker
  // at the exact text position so late layout shifts can still be compensated.
  let scrollReference = target;
  let searchMarker: HTMLSpanElement | undefined;
  if (target.dataset.searchHighlight === 'true') {
    searchMarker = document.createElement('span');
    searchMarker.setAttribute('aria-hidden', 'true');
    searchMarker.dataset.searchScrollMarker = 'true';
    searchMarker.style.cssText =
      'display:inline-block;width:0;height:0;margin:0;padding:0;overflow:hidden;vertical-align:baseline';
    target.before(searchMarker);
    scrollReference = searchMarker;
    cleanupCallbacks.push(() => searchMarker?.remove());
  }

  let desiredTop = Math.max(0, window.innerHeight / 2);

  function cleanup() {
    cleanupCallbacks.splice(0).forEach((callback) => callback());
    if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame);
    if (userSettleTimer !== undefined) window.clearTimeout(userSettleTimer);
  }

  function finish() {
    if (stopped) return;
    stopped = true;
    cleanup();
  }

  function correctPosition() {
    if (stopped || !scrollReference.isConnected) {
      finish();
      return;
    }
    if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame);
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = undefined;
      if (stopped || !scrollReference.isConnected) {
        finish();
        return;
      }
      const offset = scrollReference.getBoundingClientRect().top - desiredTop;
      if (Math.abs(offset) > SEARCH_SCROLL_TOLERANCE_PX) {
        ignoreScrollUntil = performance.now() + 100;
        window.scrollBy({top: offset, left: 0, behavior: 'auto'});
      }
    });
  }

  function userIsScrolling() {
    return performance.now() < userScrollUntil;
  }

  function noteUserScrollIntent() {
    userScrollUntil = performance.now() + SEARCH_SCROLL_USER_INPUT_MS;
    // A real wheel/touch/key event takes precedence over the short guard used
    // to ignore the scroll event emitted by our own position correction.
    ignoreScrollUntil = 0;
    if (userSettleTimer !== undefined) window.clearTimeout(userSettleTimer);
    userSettleTimer = window.setTimeout(correctPosition, SEARCH_SCROLL_USER_INPUT_MS);
  }

  const resizeObserver = new ResizeObserver(() => {
    if (!userIsScrolling()) correctPosition();
  });
  resizeObserver.observe(content);
  cleanupCallbacks.push(() => resizeObserver.disconnect());

  function handleScroll() {
    if (performance.now() < ignoreScrollUntil) return;
    if (userIsScrolling()) {
      desiredTop = scrollReference.getBoundingClientRect().top;
    } else {
      correctPosition();
    }
  }
  window.addEventListener('scroll', handleScroll, {passive: true});
  cleanupCallbacks.push(() => window.removeEventListener('scroll', handleScroll));

  for (const eventName of ['wheel', 'touchmove'] as const) {
    window.addEventListener(eventName, noteUserScrollIntent, {passive: true});
    cleanupCallbacks.push(() => window.removeEventListener(eventName, noteUserScrollIntent));
  }
  const noteKeyboardScrollIntent = (event: KeyboardEvent) => {
    if (
      ['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '].includes(event.key)
    ) {
      noteUserScrollIntent();
    }
  };
  window.addEventListener('keydown', noteKeyboardScrollIntent);
  cleanupCallbacks.push(() => window.removeEventListener('keydown', noteKeyboardScrollIntent));

  const stopForNavigation = (event: PointerEvent) => {
    if ((event.target as Element | null)?.closest('a,button,input,select,textarea,video')) finish();
  };
  window.addEventListener('pointerdown', stopForNavigation, {passive: true});
  cleanupCallbacks.push(() => window.removeEventListener('pointerdown', stopForNavigation));

  const maxSettleTimer = window.setTimeout(finish, SEARCH_SCROLL_MAX_SETTLE_MS);
  cleanupCallbacks.push(() => window.clearTimeout(maxSettleTimer));

  const retryTimers = [0, 50, 100, 250, 500, 1000].map((delay) =>
    window.setTimeout(correctPosition, delay),
  );
  cleanupCallbacks.push(() => retryTimers.forEach((timer) => window.clearTimeout(timer)));

  void document.fonts?.ready.then(correctPosition);
  return () => {
    stopped = true;
    cleanup();
  };
}

function removeSearchParameter() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('search')) return;
  url.searchParams.delete('search');
  const search = url.searchParams.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${search ? `?${search}` : ''}${url.hash}`,
  );
}

function useSearchHighlight(articleRef: React.RefObject<HTMLElement | null>, documentId: string) {
  const location = useLocation();
  const pendingQueryRef = useRef<{documentId: string; query: string} | null>(null);

  useEffect(() => {
    const suppliedQuery = new URLSearchParams(location.search).get('search')?.trim();
    const pendingQuery = pendingQueryRef.current;
    if (pendingQuery && pendingQuery.documentId !== documentId) {
      pendingQueryRef.current = null;
    }
    const query = suppliedQuery ||
      (pendingQuery?.documentId === documentId ? pendingQuery.query : undefined);

    if (!query) return undefined;

    // Strict Mode immediately re-runs effects in development. Keep the query for
    // this document until that replay has applied the visible highlight.
    pendingQueryRef.current = {documentId, query};

    const content = articleRef.current?.querySelector<HTMLElement>('.theme-doc-markdown');
    if (!content) {
      if (suppliedQuery) removeSearchParameter();
      return undefined;
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let highlights: HTMLElement[] = [];
    let fadeTimer: number | undefined;
    let removeTimer: number | undefined;
    let highlightFrame: number | undefined;
    let scrollSetupFrame: number | undefined;
    let stopScrollStabilization: (() => void) | undefined;

    const startHighlightFade = () => {
      if (highlights.length === 0) return;
      fadeTimer = window.setTimeout(
        () => highlights.forEach((highlight) => highlight.classList.add(styles.searchHighlightFading)),
        reduceMotion ? 0 : SEARCH_HIGHLIGHT_HOLD_MS,
      );
      removeTimer = window.setTimeout(
        () => removeSearchHighlights(highlights),
        reduceMotion ? 1200 : SEARCH_HIGHLIGHT_REMOVE_MS,
      );
    };

    // Insert the marks first so the scroll target can be the actual match inside
    // the selected section, rather than only the section heading.
    highlightFrame = window.requestAnimationFrame(() => {
      highlights = highlightSearchTerms(content, query);
      scrollSetupFrame = window.requestAnimationFrame(() => {
        const scrollTarget = findSearchScrollTarget(
          content,
          highlights,
          location.hash.slice(1),
        );
        if (scrollTarget) {
          stopScrollStabilization = stabilizeSearchScroll(content, scrollTarget);
        }
        startHighlightFade();
        if (suppliedQuery) removeSearchParameter();
      });
    });

    return () => {
      stopScrollStabilization?.();
      if (highlightFrame !== undefined) window.cancelAnimationFrame(highlightFrame);
      if (scrollSetupFrame !== undefined) window.cancelAnimationFrame(scrollSetupFrame);
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
      if (removeTimer !== undefined) window.clearTimeout(removeTimer);
      removeSearchHighlights(highlights);
    };
  }, [articleRef, documentId]);
}

function useDocTOC() {
  const {frontMatter, toc} = useDoc();
  const windowSize = useWindowSize();
  const hidden = frontMatter.hide_table_of_contents;
  const canRender = !hidden && toc.length > 0;

  return {
    hidden,
    mobile: canRender ? <DocItemTOCMobile /> : undefined,
    desktop:
      canRender && (windowSize === 'desktop' || windowSize === 'ssr') ? (
        <DocItemTOCDesktop />
      ) : undefined,
  };
}

function DocToolbar() {
  const {metadata} = useDoc();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const sourcePath = metadata.source
    .replace(/^@site\/docs\//, '')
    .replace(/\.(md|mdx)$/i, '.md');
  const rawUrl = useBaseUrl(`/raw-docs/${sourcePath}`);

  useEffect(() => {
    if (copyState === 'idle') return undefined;
    const timer = window.setTimeout(() => setCopyState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copyMarkdown() {
    try {
      const response = await fetch(rawUrl);
      if (!response.ok) throw new Error(`Markdown request failed: ${response.status}`);
      const markdown = await response.text();
      await navigator.clipboard.writeText(markdown);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  const label =
    copyState === 'copied'
      ? '已复制'
      : copyState === 'error'
        ? '复制失败'
        : '复制为 Markdown';

  return (
    <div className={styles.docToolbar}>
      <DocBreadcrumbs />
      <button
        type="button"
        className={styles.copyButton}
        onClick={copyMarkdown}
        aria-label="复制页面为 Markdown">
        {copyState === 'copied' ? (
          <Check aria-hidden="true" size={16} />
        ) : (
          <Copy aria-hidden="true" size={16} />
        )}
        <span>{label}</span>
      </button>
    </div>
  );
}

export default function DocItemLayout({children}: Props): ReactNode {
  const docTOC = useDocTOC();
  const {metadata, frontMatter} = useDoc();
  const articleRef = React.useRef<HTMLElement>(null);

  useSearchHighlight(articleRef, metadata.id);

  return (
    <div className={clsx('row', styles.docLayout)}>
      <div className={clsx('col', docTOC.desktop && styles.docItemCol)}>
        <ContentVisibility metadata={metadata} />
        <DocVersionBanner />
        <div className={styles.docItemContainer}>
          <article ref={articleRef}>
            <DocToolbar />
            <DocVersionBadge />
            {docTOC.mobile}
            <DocItemContent>{children}</DocItemContent>
            <OutlinePageNavigation frontMatter={frontMatter as Record<string, unknown>} />
            <DocItemFooter />
          </article>
          <DocItemPaginator />
        </div>
      </div>
      {docTOC.desktop && (
        <aside className={clsx('col col--3', styles.tocColumn)}>{docTOC.desktop}</aside>
      )}
    </div>
  );
}
