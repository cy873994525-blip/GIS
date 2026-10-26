/*
 * 盆地沉降回剥分析
 *
 * 这个文件不依赖 ArcGIS、Chart.js 或其他第三方库。它只负责把地层厚度
 * 转换为去压实后的原始厚度，并按简化 Airy 均衡公式计算沉降历史。
 * 页面通过 window.Backstrip.backstrip(formations, options) 调用它。
 */
(function exposeBackstrip(global) {
  "use strict";

  const LITHOLOGY_PARAMETERS = Object.freeze({
    sandstone: Object.freeze({ phi0: 0.49, c: 0.27e-3, grainDensity: 2650 }),
    shale: Object.freeze({ phi0: 0.63, c: 0.51e-3, grainDensity: 2720 }),
    limestone: Object.freeze({ phi0: 0.60, c: 0.55e-3, grainDensity: 2710 }),
    siltstone: Object.freeze({ phi0: 0.56, c: 0.39e-3, grainDensity: 2680 }),
    coal: Object.freeze({ phi0: 0.70, c: 0.80e-3, grainDensity: 1300 }),
  });

  const DEFAULT_DENSITY = Object.freeze({
    mantle: 3330,
    water: 1030,
    referenceSediment: 2500,
  });

  function asFiniteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new TypeError(`${label} 必须是有限数字。`);
    }
    return number;
  }

  function readOption(options, key, index) {
    const values = options && Array.isArray(options[key]) ? options[key] : [];
    // 未提供古水深或海平面数组时，按 0 m 处理，便于只做地层去压实。
    return values[index] === undefined || values[index] === ""
      ? 0
      : asFiniteNumber(values[index], `options.${key}[${index}]`);
  }

  function validateFormation(formation, index) {
    if (!formation || typeof formation !== "object") {
      throw new TypeError(`formations[${index}] 必须是对象。`);
    }

    const topDepth = asFiniteNumber(formation.topDepth, `formations[${index}].topDepth`);
    const bottomDepth = asFiniteNumber(formation.bottomDepth, `formations[${index}].bottomDepth`);
    const age = asFiniteNumber(formation.age, `formations[${index}].age`);
    const lithology = formation.lithology || "sandstone";

    if (topDepth < 0 || bottomDepth <= topDepth) {
      throw new RangeError(`formations[${index}] 的深度必须满足 0 <= topDepth < bottomDepth。`);
    }
    if (age < 0) {
      throw new RangeError(`formations[${index}].age 不能为负数。`);
    }
    if (!Object.prototype.hasOwnProperty.call(LITHOLOGY_PARAMETERS, lithology)) {
      throw new RangeError(`formations[${index}].lithology 不支持：${lithology}。`);
    }

    return {
      name: String(formation.name || `Formation ${index + 1}`),
      topDepth,
      bottomDepth,
      age,
      lithology,
      sourceIndex: index,
    };
  }

  /**
   * 执行沉降回剥分析。
   *
   * depth 采用从新到老累计的去压实原始厚度，代表每个底界在沉积序列中
   * 的累计深度。输出深度和沉降量均使用正值；绘图模块再把它们转换为向下
   * 的负值，以便符合地质剖面图的显示习惯。
   */
  function backstrip(formations, options = {}) {
    if (!Array.isArray(formations) || formations.length === 0) {
      throw new TypeError("formations 必须是非空数组。 ");
    }

    const optionKeys = ["paleoWaterDepth", "seaLevel"];
    optionKeys.forEach((key) => {
      if (options[key] !== undefined && !Array.isArray(options[key])) {
        throw new TypeError(`options.${key} 必须是数组。`);
      }
      if (Array.isArray(options[key]) && options[key].length !== formations.length) {
        throw new RangeError(`options.${key} 的长度必须与 formations 一致。`);
      }
    });

    // 复制后按年龄升序排列，既不修改调用方数组，也兼容用户输入顺序混乱。
    const normalised = formations
      .map(validateFormation)
      .sort((a, b) => a.age - b.age || a.sourceIndex - b.sourceIndex);

    const diagnostics = {
      inputOrderWasResorted: normalised.some((item, index) => item.sourceIndex !== index),
      warnings: [],
      stratigraphicGaps: [],
      clampedPorosityIntervals: [],
    };

    for (let index = 1; index < normalised.length; index += 1) {
      if (normalised[index].age === normalised[index - 1].age) {
        throw new RangeError("相邻地层的底界年龄不能相同，否则无法计算沉降速率。 ");
      }
    }

    const density = {
      ...DEFAULT_DENSITY,
      ...(options.density || {}),
    };
    const rhoM = asFiniteNumber(density.mantle, "density.mantle");
    const rhoW = asFiniteNumber(density.water, "density.water");
    const rhoS = asFiniteNumber(density.referenceSediment, "density.referenceSediment");
    if ([rhoM, rhoW, rhoS].some((value) => value <= 0)) {
      throw new RangeError("地幔、水和沉积物密度必须为正数。 ");
    }
    if (rhoM <= rhoS || rhoS <= rhoW) {
      throw new RangeError("密度必须满足 rhoM > rhoS > rhoW。 ");
    }

    let cumulativeOriginalThickness = 0;
    const formationResults = [];
    const burialHistory = [];
    const tectonicSubsidence = [];

    normalised.forEach((formation, outputIndex) => {
      const parameters = LITHOLOGY_PARAMETERS[formation.lithology];
      const thickness = formation.bottomDepth - formation.topDepth;

      if (outputIndex > 0) {
        const previous = normalised[outputIndex - 1];
        const gap = formation.topDepth - previous.bottomDepth;
        if (Math.abs(gap) > 1e-6) {
          diagnostics.stratigraphicGaps.push({
            youngerFormation: previous.name,
            olderFormation: formation.name,
            gap,
          });
        }
      }

      // φ(z) = φ0 exp(-cz)。对该区间积分后得到题目要求的平均孔隙度公式。
      const phiTop = parameters.phi0 * Math.exp(-parameters.c * formation.topDepth);
      const phiBottom = parameters.phi0 * Math.exp(-parameters.c * formation.bottomDepth);
      const cThickness = parameters.c * thickness;
      // 对极薄层使用 expm1 的等价形式，避免 phiTop - phiBottom 的浮点消减。
      const calculatedPhiAverage = Math.abs(cThickness) < 1e-5
        ? phiTop * (-Math.expm1(-cThickness) / cThickness)
        : (phiTop - phiBottom) / cThickness;
      // 深度异常时仍保持物理可行范围，避免产生负骨架厚度。
      const phiAverage = Math.min(1, Math.max(0, calculatedPhiAverage));
      if (phiAverage !== calculatedPhiAverage) {
        diagnostics.clampedPorosityIntervals.push({
          formation: formation.name,
          calculatedPhiAverage,
          usedPhiAverage: phiAverage,
        });
      }
      const skeletonThickness = thickness * (1 - phiAverage);
      const originalThickness = skeletonThickness / (1 - parameters.phi0);

      cumulativeOriginalThickness += originalThickness;
      const paleoWaterDepth = readOption(options, "paleoWaterDepth", formation.sourceIndex);
      const seaLevel = readOption(options, "seaLevel", formation.sourceIndex);
      if (paleoWaterDepth < 0) {
        diagnostics.warnings.push(`${formation.name} 的古水深为负值，请确认输入。`);
      }

      // 总沉降取累计原始厚度加上水深/海平面项。这样可由总沉降减去
      // 构造沉降得到负载沉降，且三者在数值上严格闭合。
      const totalSubsidence = cumulativeOriginalThickness + paleoWaterDepth - seaLevel;
      const loadSubsidence = cumulativeOriginalThickness
        * (rhoS - rhoW) / (rhoM - rhoW);
      const tectonicValue = cumulativeOriginalThickness
        * (rhoM - rhoS) / (rhoM - rhoW)
        + paleoWaterDepth
        - seaLevel;

      formationResults.push({
        name: formation.name,
        age: formation.age,
        lithology: formation.lithology,
        topDepth: formation.topDepth,
        bottomDepth: formation.bottomDepth,
        presentThickness: thickness,
        phiTop,
        phiBottom,
        phiAverage,
        skeletonThickness,
        originalThickness,
        cumulativeOriginalThickness,
        compactionRatio: originalThickness / thickness,
        paleoWaterDepth,
        seaLevel,
        grainDensity: parameters.grainDensity,
      });

      burialHistory.push({
        age: formation.age,
        depth: cumulativeOriginalThickness,
        waterDepth: paleoWaterDepth,
      });

      tectonicSubsidence.push({
        age: formation.age,
        totalSubsidence,
        tectonicSubsidence: tectonicValue,
        loadSubsidence,
      });
    });

    const rates = [];
    for (let index = 0; index < tectonicSubsidence.length - 1; index += 1) {
      const from = tectonicSubsidence[index];
      const to = tectonicSubsidence[index + 1];
      const deltaAge = to.age - from.age;
      rates.push({
        ageFrom: from.age,
        ageTo: to.age,
        // 年龄从新到老递增，所以正值表示随地质时间向老年方向增加沉降。
        rate: (to.tectonicSubsidence - from.tectonicSubsidence) / deltaAge,
      });
    }

    if (diagnostics.inputOrderWasResorted) {
      diagnostics.warnings.push("输入地层已按底界年龄从小到大重新排序。 ");
    }
    if (diagnostics.stratigraphicGaps.length) {
      diagnostics.warnings.push("相邻地层深度存在间断或重叠，累计厚度仍按各层输入值计算。 ");
    }
    if (diagnostics.clampedPorosityIntervals.length) {
      diagnostics.warnings.push("部分区间的平均孔隙度超出物理范围，已进行截断。 ");
    }

    const finalTectonic = tectonicSubsidence[tectonicSubsidence.length - 1];
    const totalOriginalThickness = cumulativeOriginalThickness;
    const averageRate = rates.length
      ? rates.reduce((sum, item) => sum + item.rate, 0) / rates.length
      : 0;

    return {
      burialHistory,
      tectonicSubsidence,
      rates,
      summary: {
        formationCount: normalised.length,
        youngestAge: normalised[0].age,
        oldestAge: normalised[normalised.length - 1].age,
        totalOriginalThickness,
        finalTectonicSubsidence: finalTectonic.tectonicSubsidence,
        finalTotalSubsidence: finalTectonic.totalSubsidence,
        averageTectonicRate: averageRate,
      },
      diagnostics,
      formationResults,
      constants: {
        density: { mantle: rhoM, water: rhoW, referenceSediment: rhoS },
        lithologyParameters: LITHOLOGY_PARAMETERS,
      },
    };
  }

  global.Backstrip = Object.freeze({ backstrip });
}(window));
