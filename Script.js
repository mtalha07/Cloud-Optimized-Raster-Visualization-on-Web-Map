var map=L.map('map',{preferCanvas:true,zoomControl:true});

var basemap=L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    {maxZoom:19,attribution:'Tiles &copy; Esri'}
).addTo(map);

var geoserverWMS='http://202.166.161.115:8079/geoserver/Raster_Space/wms';

var rgbLayer=L.tileLayer.wms(geoserverWMS,{
    layers:'Raster_Space:Landsat9_RGB_clean_COG',
    styles:'',
    format:'image/png',
    transparent:true,
    version:'1.1.1'
}).addTo(map);

var ndviLayer=L.tileLayer.wms(geoserverWMS,{
    layers:'Raster_Space:Landsat9_NDVI_COG',
    styles:'',
    format:'image/png',
    transparent:true,
    version:'1.1.1'
});

var rasterLayers=[
    {leafletLayer:rgbLayer,layerName:'Raster_Space:Landsat9_RGB_clean_COG',title:'Landsat 9 RGB',type:'rgb'},
    {leafletLayer:ndviLayer,layerName:'Raster_Space:Landsat9_NDVI_COG',title:'NDVI',type:'ndvi'}
];

L.control.layers(
    {'Esri Street Map':basemap},
    {'Landsat 9 RGB':rgbLayer,'NDVI':ndviLayer},
    {collapsed:false}
).addTo(map);

var rasterBounds=L.latLngBounds(
    [30.3000847,73.0268342],
    [33.0179376,75.3671252]
);

map.fitBounds(rasterBounds,{padding:[25,25],maxZoom:9});

var visibleRasterStack=[rgbLayer];

function getConfigByLayer(layer){
    return rasterLayers.find(function(r){
        return r.leafletLayer===layer;
    });
}

function getTopVisibleRaster(){
    for(var i=visibleRasterStack.length-1;i>=0;i--){
        if(map.hasLayer(visibleRasterStack[i])){
            return getConfigByLayer(visibleRasterStack[i]);
        }
    }

    for(var j=rasterLayers.length-1;j>=0;j--){
        if(map.hasLayer(rasterLayers[j].leafletLayer)){
            return rasterLayers[j];
        }
    }

    return null;
}

function updateCursor(){
    var rasterVisible=rasterLayers.some(function(r){
        return map.hasLayer(r.leafletLayer);
    });

    map.getContainer().style.cursor=rasterVisible?'pointer':'grab';
}

var legendControl=L.control({position:'bottomleft'});

legendControl.onAdd=function(){
    var div=L.DomUtil.create('div','raster-legend');
    div.id='rasterLegend';
    return div;
};

legendControl.addTo(map);

function buildLegendURL(config){
    var params=new URLSearchParams({
        SERVICE:'WMS',
        VERSION:'1.1.1',
        REQUEST:'GetLegendGraphic',
        FORMAT:'image/png',
        LAYER:config.layerName,
        WIDTH:20,
        HEIGHT:20,
        LEGEND_OPTIONS:'fontName:Arial;fontSize:11;forceLabels:on'
    });

    return geoserverWMS+'?'+params.toString();
}

function updateLegend(){
    var legend=document.getElementById('rasterLegend');
    var config=getTopVisibleRaster();

    if(!config){
        legend.style.display='none';
        legend.innerHTML='';
        return;
    }

    legend.style.display='block';
    legend.innerHTML=
        '<div class="raster-legend-title">'+config.title+'</div>'+
        '<img src="'+buildLegendURL(config)+'" alt="'+config.title+' legend">';
}

map.on('overlayadd',function(e){
    visibleRasterStack=visibleRasterStack.filter(function(layer){
        return layer!==e.layer;
    });

    visibleRasterStack.push(e.layer);

    if(e.layer.bringToFront){
        e.layer.bringToFront();
    }

    updateCursor();
    updateLegend();
});

map.on('overlayremove',function(e){
    visibleRasterStack=visibleRasterStack.filter(function(layer){
        return layer!==e.layer;
    });

    updateCursor();
    updateLegend();
});

updateCursor();
updateLegend();

map.on('click',function(e){
    var active=rasterLayers.filter(function(r){
        return map.hasLayer(r.leafletLayer);
    });

    if(!active.length){
        return;
    }

    Promise.all(active.map(function(r){
        return queryRasterPixel(r,e.latlng);
    }))
    .then(function(results){
        results=results.filter(function(r){
            return r!==null;
        });

        if(!results.length){
            return;
        }

        var html=
            '<div style="min-width:220px">'+
            '<b>Raster Pixel</b><br>'+
            'Latitude: '+e.latlng.lat.toFixed(6)+'<br>'+
            'Longitude: '+e.latlng.lng.toFixed(6)+'<hr>';

        results.forEach(function(r){
            html+=r.html;
        });

        html+='</div>';

        L.popup({maxWidth:350})
            .setLatLng(e.latlng)
            .setContent(html)
            .openOn(map);
    })
    .catch(function(err){
        console.error('Raster query error:',err);
    });
});

function queryRasterPixel(config,latlng){
    var point=map.latLngToContainerPoint(latlng);
    var size=map.getSize();
    var bounds=map.getBounds();

    var sw=map.options.crs.project(bounds.getSouthWest());
    var ne=map.options.crs.project(bounds.getNorthEast());

    var bbox=[sw.x,sw.y,ne.x,ne.y].join(',');

    var params={
        SERVICE:'WMS',
        VERSION:'1.1.1',
        REQUEST:'GetFeatureInfo',
        LAYERS:config.layerName,
        QUERY_LAYERS:config.layerName,
        STYLES:'',
        BBOX:bbox,
        FEATURE_COUNT:1,
        HEIGHT:size.y,
        WIDTH:size.x,
        FORMAT:'image/png',
        INFO_FORMAT:'application/json',
        SRS:'EPSG:3857',
        X:Math.round(point.x),
        Y:Math.round(point.y)
    };

    var url=geoserverWMS+'?'+new URLSearchParams(params).toString();

    return fetch(url)
        .then(function(response){
            return response.text().then(function(text){
                if(!response.ok){
                    throw new Error(text);
                }

                var clean=text.trim();

                if(clean.startsWith('<?xml')||clean.startsWith('<ServiceException')){
                    console.error('GeoServer XML error:',text);
                    throw new Error('GeoServer returned XML instead of JSON');
                }

                return JSON.parse(text);
            });
        })
        .then(function(data){
            if(!data.features||!data.features.length){
                return null;
            }

            return buildPixelResult(config,data.features[0].properties);
        })
        .catch(function(err){
            console.error(config.title,err);
            return null;
        });
}

function buildPixelResult(config,p){
    if(config.type==='rgb'){
        var red=getNumber(p,['Band1','band1','RED_BAND']);
        var green=getNumber(p,['Band2','band2','GREEN_BAND']);
        var blue=getNumber(p,['Band3','band3','BLUE_BAND']);

        if(red===null&&green===null&&blue===null){
            return null;
        }

        return{
            html:
                '<b>Landsat 9 RGB</b><br>'+
                'Red (B4): '+formatNumber(red,4)+'<br>'+
                'Green (B3): '+formatNumber(green,4)+'<br>'+
                'Blue (B2): '+formatNumber(blue,4)+'<hr>'
        };
    }

    if(config.type==='ndvi'){
        var ndvi=getNumber(p,['Band1','band1','GRAY_INDEX']);

        if(ndvi===null){
            return null;
        }

        return{
            html:'<b>NDVI</b><br>Value: '+ndvi.toFixed(4)+'<hr>'
        };
    }

    return null;
}

function getNumber(properties,names){
    for(var i=0;i<names.length;i++){
        if(Object.prototype.hasOwnProperty.call(properties,names[i])){
            var value=Number(properties[names[i]]);

            if(Number.isFinite(value)){
                return value;
            }
        }
    }

    return null;
}

function formatNumber(value,decimals){
    return value===null?'-':value.toFixed(decimals);
}

window.addEventListener('resize',function(){
    map.invalidateSize();
});