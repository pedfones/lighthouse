/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview Audit which identifies third-party code on the page which can be lazy loaded.
 * The audit will recommend a facade alternative which is used to imitate the third party resource until it is needed.
 *
 * Entity: Set of domains which are used by a company or product area to deliver third party resources
 * Product: Specific piece of software belonging to an entity. Entities can have multiple products.
 * Facade: Placeholder for a product which looks likes the actual product and replaces itself with that product when the user needs it.
 */

const Audit = require('./audit.js');
const i18n = require('../lib/i18n/i18n.js');
const thirdPartyWeb = require('../lib/third-party-web.js');
const NetworkRecords = require('../computed/network-records.js');
const MainResource = require('../computed/main-resource.js');
const MainThreadTasks = require('../computed/main-thread-tasks.js');
const ThirdPartySummary = require('./third-party-summary.js');

const UIStrings = {
  /** Title of a diagnostic audit that provides details about the third-party code on a web page that can be lazy loaded with a facade alternative. This descriptive title is shown to users when no resources have facade alternatives available. Lazy loading means loading resources is deferred until they are needed. */
  title: 'Lazy load third-party resources with facade alternatives',
  /** Title of a diagnostic audit that provides details about the third-party code on a web page that can be lazy loaded with a facade alternative. This descriptive title is shown to users when one or more third-party resources have available facade alternatives. Lazy loading means loading resources is deferred until they are needed. */
  failureTitle: 'Some third-party resources can be lazy loaded with a facade alternative',
  /** Description of a Lighthouse audit that identifies the third party code on the page that can be lazy loaded with a facade alternative. This is displayed after a user expands the section to see more. No character length limits. 'Learn More' becomes link text to additional documentation. Lazy loading means loading resources is deferred until they are needed. */
  description: 'Some third-party resources can be fetched after the page loads. ' +
    'These third-party resources are used by embedded elements which can be replaced by a facade ' +
    'until the user needs to use them. [Learn more](https://web.dev/efficiently-load-third-party-javascript/).',
  /** Summary text for the result of a Lighthouse audit that identifies the third party code on a web page that can be lazy loaded with a facade alternative. This text summarizes the number of lazy loading facades that can be used on the page. Lazy loading means loading resources is deferred until they are needed. */
  displayValue: `{itemCount, plural,
  =1 {# facade alternative available}
  other {# facade alternatives available}
  }`,
  /** Label for a table column that displays the name of the third party product that a URL is used for. */
  columnProduct: 'Product',
  /**
   * @description Template for an entry in the "Product" column for a third party product which is in the video category.
   * @example {YouTube Embed} productName
   */
  categoryVideo: '{productName} (Video)',
  /**
   * @description Template for an entry in the "Product" column for a third party product which is in the customer success category.
   * @example {Intercom Widget} productName
   */
  categoryCustomerSuccess: '{productName} (Customer Success)',
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);
const CATEGORY_UI_MAP = new Map([
  ['video', UIStrings.categoryVideo],
  ['customer-success', UIStrings.categoryCustomerSuccess],
]);

/** @typedef {import("third-party-web").IEntity} ThirdPartyEntity */
/** @typedef {import("third-party-web").IProduct} ThirdPartyProduct*/
/** @typedef {import("third-party-web").IFacade} ThirdPartyFacade*/

/** @typedef {{
 *  product: ThirdPartyProduct,
 *  cutoffTime: number,
 *  urlSummaries: Map<string, ThirdPartySummary.Summary>
 * }} FacadableProductSummary
 */

class ThirdPartyFacades extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'third-party-facades',
      title: str_(UIStrings.title),
      failureTitle: str_(UIStrings.failureTitle),
      description: str_(UIStrings.description),
      requiredArtifacts: ['traces', 'devtoolsLogs', 'URL'],
    };
  }

  /**
   * @param {Map<string, ThirdPartySummary.Summary>} byURL
   * @param {ThirdPartyEntity | undefined} mainEntity
   * @return {FacadableProductSummary[]}
   */
  static getFacadableProductSummaries(byURL, mainEntity) {
    /** @type {Map<string, Map<string, FacadableProductSummary>>} */
    const entitySummaries = new Map();

    for (const [url, urlSummary] of byURL) {
      const entity = thirdPartyWeb.getEntity(url);
      if (!entity || thirdPartyWeb.isFirstParty(url, mainEntity)) continue;

      const productSummaries = entitySummaries.get(entity.name) || new Map();
      const product = thirdPartyWeb.getProduct(url);
      if (product && product.facades && product.facades.length) {
        // Record new url if product has a facade.

        /** @type {FacadableProductSummary} */
        const productSummary = productSummaries.get(product.name) || {
          product,
          cutoffTime: Infinity,
          urlSummaries: new Map(),
        };

        productSummary.urlSummaries.set(url, urlSummary);

        // This is the time the product resource is fetched.
        // Any resources of the same entity fetched after this point are considered as part of this product.
        productSummary.cutoffTime = Math.min(productSummary.cutoffTime, urlSummary.firstEndTime);

        productSummaries.set(product.name, productSummary);
      }
      entitySummaries.set(entity.name, productSummaries);
    }

    for (const [url, urlSummary] of byURL) {
      const entity = thirdPartyWeb.getEntity(url);
      if (!entity || thirdPartyWeb.isFirstParty(url, mainEntity)) continue;

      const productSummaries = entitySummaries.get(entity.name) || new Map();
      const product = thirdPartyWeb.getProduct(url);
      if (!product || !product.facades || !product.facades.length) {
        // If the url does not have a facade but one or more products on its entity do,
        // we still want to record this url because it was probably fetched by a product with a facade.
        for (const productSummary of productSummaries.values()) {
          if (urlSummary.firstStartTime < productSummary.cutoffTime) continue;
          productSummary.urlSummaries.set(url, urlSummary);
        }
      }
      entitySummaries.set(entity.name, productSummaries);
    }

    const allProductSummaries = [];
    for (const productSummaries of entitySummaries.values()) {
      for (const productSummary of productSummaries.values()) {
        allProductSummaries.push(productSummary);
      }
    }
    return allProductSummaries;
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {LH.Audit.Context} context
   * @return {Promise<LH.Audit.Product>}
   */
  static async audit(artifacts, context) {
    const settings = context.settings;
    const trace = artifacts.traces[Audit.DEFAULT_PASS];
    const devtoolsLog = artifacts.devtoolsLogs[Audit.DEFAULT_PASS];
    const networkRecords = await NetworkRecords.request(devtoolsLog, context);
    const mainResource = await MainResource.request({devtoolsLog, URL: artifacts.URL}, context);
    const mainEntity = thirdPartyWeb.getEntity(mainResource.url);
    const tasks = await MainThreadTasks.request(trace, context);
    const multiplier = settings.throttlingMethod === 'simulate' ?
      settings.throttling.cpuSlowdownMultiplier : 1;
    const thirdPartySummaries = ThirdPartySummary.getSummaries(networkRecords, tasks, multiplier);
    const productSummaries
      = ThirdPartyFacades.getFacadableProductSummaries(thirdPartySummaries.byURL, mainEntity);

    const summary = {wastedBytes: 0, wastedMs: 0};

    /** @type {LH.Audit.Details.TableItem[]} */
    const results = [];
    for (const productSummary of productSummaries) {
      const product = productSummary.product;
      const categoryTemplate = CATEGORY_UI_MAP.get(product.categories[0]);

      // Display product name with category next to it in the same column
      let productWithCategory = product.name;
      if (categoryTemplate) {
        productWithCategory = str_(categoryTemplate, {productName: product.name});
      }

      const items = [];
      let transferSize = 0;
      let blockingTime = 0;
      for (const [url, urlStats] of productSummary.urlSummaries) {
        items.push({url, ...urlStats});
        transferSize += urlStats.transferSize;
        blockingTime += urlStats.blockingTime;
      }
      items.sort((a, b) => {
        return b.transferSize - a.transferSize;
      });
      summary.wastedBytes += transferSize;
      summary.wastedMs += blockingTime;
      results.push({
        product: productWithCategory,
        transferSize,
        blockingTime,
        subItems: {type: 'subitems', items},
      });
    }

    if (!results.length) {
      return {
        score: 1,
        notApplicable: true,
      };
    }

    /** @type {LH.Audit.Details.Table['headings']} */
    const headings = [
      /* eslint-disable max-len */
      {key: 'product', itemType: 'text', subItemsHeading: {key: 'url', itemType: 'url'}, text: str_(UIStrings.columnProduct)},
      {key: 'transferSize', granularity: 1, itemType: 'bytes', subItemsHeading: {key: 'transferSize'}, text: str_(i18n.UIStrings.columnTransferSize)},
      {key: 'blockingTime', granularity: 1, itemType: 'ms', subItemsHeading: {key: 'blockingTime'}, text: str_(i18n.UIStrings.columnBlockingTime)},
      /* eslint-enable max-len */
    ];

    return {
      score: 0,
      displayValue: str_(UIStrings.displayValue, {
        itemCount: results.length,
      }),
      details: Audit.makeTableDetails(headings, results, summary),
    };
  }
}

module.exports = ThirdPartyFacades;
module.exports.UIStrings = UIStrings;